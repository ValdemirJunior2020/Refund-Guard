import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { z } from "zod";

/* -------------------------
   Force-load .env from THIS folder
   AND override Windows user env vars
------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: "http://localhost:5173" }));
app.use(helmet());
app.use(morgan("dev"));

const PORT = Number(process.env.PORT || 5051);
const RAW_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const KEY = process.env.GEMINI_API_KEY || "";

// normalize: allow GEMINI_MODEL=models/xxx OR gemini-xxx
const MODEL = RAW_MODEL.startsWith("models/")
  ? RAW_MODEL.replace("models/", "")
  : RAW_MODEL;

console.log("✅ Server booting...");
console.log("🤖 Gemini model:", MODEL);
console.log("📄 Loaded env from:", path.join(__dirname, ".env"));
console.log("🔑 GEMINI_API_KEY loaded?", KEY.length > 0);
console.log("🔑 KEY prefix:", KEY ? KEY.slice(0, 6) : "(missing)");
console.log("🔑 KEY suffix:", KEY ? KEY.slice(-4) : "(missing)");

if (!KEY) {
  console.error("❌ Missing GEMINI_API_KEY in server/.env");
  process.exit(1);
}

/* -------------------------
   Validation
------------------------- */
const AnalyzeSchema = z.object({
  rawNotes: z.string().min(10),
  issueType: z.string().min(1),
  bookingTotal: z.number().nullable().optional(),
  refundedAmount: z.number().nullable().optional(),
// NEW:
  encouragedRefundCapPercent: z.number().default(15),
  maxRefundCapPercent: z.number().default(20),
});

function computeRefundPercent(total, refunded) {
  if (!total || total <= 0) return null;
  if (refunded == null) return null;
  return (refunded / total) * 100;
}

function buildPrompt(input) {
  const refundPercent = computeRefundPercent(input.bookingTotal, input.refundedAmount);

  return `
You are a Refund & Chargeback Risk Predictor for a travel call center.

POLICY (NON-NEGOTIABLE):
- Encouraged refund cap: ${input.encouragedRefundCapPercent}% (try to stay at or under this)
- Maximum agent refund cap: ${input.maxRefundCapPercent}% (over this requires manager escalation)
- If refund is between ${input.encouragedRefundCapPercent}% and ${input.maxRefundCapPercent}%, treat as HIGH scrutiny and recommend escalation.
- Never promise refunds, approvals, or free upgrades.

Return ONLY valid JSON with this exact shape:
{
  "risk_score": number,
  "risk_level": "low" | "medium" | "high",
  "confidence": number,
  "signals": [
    { "name": string, "evidence_quote": string, "weight": number }
  ],
  "warnings": [string],
  "recommended_script": [string],
  "next_steps": [string],
  "missing_info": [string]
}

INPUTS:
Issue Type: ${input.issueType}
Booking Total: ${input.bookingTotal ?? "unknown"}
Refunded Amount: ${input.refundedAmount ?? "unknown"}
Refund Percent: ${refundPercent == null ? "unknown" : refundPercent.toFixed(2) + "%"}

AGENT NOTES:
"""
${input.rawNotes}
"""
`.trim();
}

/* -------------------------
   Gemini REST call (no SDK)
------------------------- */
async function geminiGenerateJson(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    MODEL
  )}:generateContent?key=${encodeURIComponent(KEY)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const raw = await resp.text();

  if (!resp.ok) {
    // return Google raw error
    throw new Error(raw);
  }

  const json = JSON.parse(raw);

  const modelText = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!modelText) throw new Error("No model text returned");

  // responseMimeType should return pure JSON, but keep safe fallback
  try {
    return JSON.parse(modelText);
  } catch {
    const start = modelText.indexOf("{");
    const end = modelText.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model did not return JSON");
    }
    return JSON.parse(modelText.slice(start, end + 1));
  }
}

/* -------------------------
   Routes
------------------------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.get("/debug/gemini", async (req, res) => {
  try {
    const data = await geminiGenerateJson(`Return ONLY JSON: {"ok": true, "msg": "hello"}`);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const input = AnalyzeSchema.parse(req.body);
    const prompt = buildPrompt(input);
    const data = await geminiGenerateJson(prompt);
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("❌ Analyze error:", msg);
    res.status(400).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
