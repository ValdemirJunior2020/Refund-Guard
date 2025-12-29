import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { z } from "zod";

/* -------------------------
   Load .env from server folder
   AND override Windows user env vars (your exact issue)
------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(helmet());
app.use(morgan("dev"));

/* -------------------------
   Config
------------------------- */
const PORT = Number(process.env.PORT || 5051);
const RAW_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const KEY = process.env.GEMINI_API_KEY || "";

// Normalize: allow GEMINI_MODEL=models/xxx OR gemini-xxx
const MODEL = RAW_MODEL.startsWith("models/")
  ? RAW_MODEL.replace("models/", "")
  : RAW_MODEL;

// CORS: allow local + your Netlify domain (set FRONTEND_URL on Render)
const allowedOrigins = [
  "http://localhost:5173",
  process.env.FRONTEND_URL, // e.g. https://your-site.netlify.app
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // allow non-browser tools (no origin)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      return callback(
        new Error(
          `CORS blocked. Origin not allowed: ${origin}. Allowed: ${allowedOrigins.join(
            ", "
          )}`
        )
      );
    },
  })
);

console.log("✅ Server booting...");
console.log("🤖 Gemini model:", MODEL);
console.log("📄 Loaded env from:", path.join(__dirname, ".env"));
console.log("🔑 GEMINI_API_KEY loaded?", KEY.length > 0);
console.log("🔑 KEY prefix:", KEY ? KEY.slice(0, 6) : "(missing)");
console.log("🔑 KEY suffix:", KEY ? KEY.slice(-4) : "(missing)");
console.log("🌐 FRONTEND_URL:", process.env.FRONTEND_URL || "(not set yet)");

if (!KEY) {
  console.error("❌ Missing GEMINI_API_KEY in server/.env or Render env vars.");
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

  // NEW POLICY:
  encouragedRefundCapPercent: z.number().default(15), // encouraged max
  maxRefundCapPercent: z.number().default(20), // allowed max for agents
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
- Maximum agent refund cap: ${input.maxRefundCapPercent}% (agents may refund up to this, but it should trigger escalation)
- If refund percent is between ${input.encouragedRefundCapPercent}% and ${input.maxRefundCapPercent}%, treat as HIGH scrutiny and recommend escalation/manager review.
- If refund percent is above ${input.maxRefundCapPercent}%, label it as a POLICY VIOLATION and recommend immediate manager escalation.
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
  "missing_info": [string],
  "policy": {
    "encouraged_cap_percent": number,
    "max_cap_percent": number,
    "refund_percent": number | null,
    "soft_cap_exceeded": boolean,
    "hard_cap_exceeded": boolean
  }
}

RISK GUIDELINES:
- Sales error/misrepresentation claims, billing discrepancies, angry disconnects, hotel unreachable => increase risk
- Missing info => reduce confidence and request clarification

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
   Gemini REST call (matches your working PowerShell test)
------------------------- */
async function geminiGenerateJson(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    MODEL
  )}:generateContent?key=${encodeURIComponent(KEY)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();

  if (!resp.ok) {
    // pass Google raw error up to client
    throw new Error(raw);
  }

  const json = JSON.parse(raw);
  const modelText = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  if (!modelText) throw new Error("No model text returned");

  // Should already be JSON due to responseMimeType
  return JSON.parse(modelText);
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

    const refundPercent = computeRefundPercent(input.bookingTotal, input.refundedAmount);
    const softCapExceeded =
      refundPercent != null && refundPercent > input.encouragedRefundCapPercent;
    const hardCapExceeded =
      refundPercent != null && refundPercent > input.maxRefundCapPercent;

    const prompt = buildPrompt(input);
    const data = await geminiGenerateJson(prompt);

    // Ensure policy object is present even if model forgets
    const merged = {
      ...data,
      policy: {
        encouraged_cap_percent: input.encouragedRefundCapPercent,
        max_cap_percent: input.maxRefundCapPercent,
        refund_percent: refundPercent,
        soft_cap_exceeded: softCapExceeded,
        hard_cap_exceeded: hardCapExceeded,
        ...(data?.policy || {}),
      },
    };

    res.json(merged);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("❌ Analyze error:", msg);
    res.status(400).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
