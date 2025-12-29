import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db, initAnalytics } from "./firebase";
import "./App.css";

const API_BASE = "http://localhost:5051";

type RiskSignal = {
  name: string;
  evidence_quote: string;
  weight: number;
};

type RiskResult = {
  risk_score: number;
  risk_level: "low" | "medium" | "high";
  confidence: number;
  signals: RiskSignal[];
  warnings: string[];
  recommended_script: string[];
  next_steps: string[];
  missing_info: string[];
  meta?: {
    model?: string;
  };
};

function toNumber(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default function App() {
  const [rawNotes, setRawNotes] = useState<string>("");
  const [issueType, setIssueType] = useState<string>("Modification");
  const [bookingTotal, setBookingTotal] = useState<string>("");
  const [refundedAmount, setRefundedAmount] = useState<string>("");

  // ✅ Agent Email is used in the UI and saved to Firestore
  const [agentEmail, setAgentEmail] = useState<string>("");

  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<RiskResult | null>(null);
  const [saveStatus, setSaveStatus] = useState<string>("");

  useEffect(() => {
    initAnalytics();
  }, []);

  const refundPercent = useMemo<number | null>(() => {
    const total = toNumber(bookingTotal);
    const refunded = toNumber(refundedAmount);
    if (!total || total <= 0 || refunded == null) return null;
    return (refunded / total) * 100;
  }, [bookingTotal, refundedAmount]);

  const capWarning =
    refundPercent != null && refundPercent > 15
      ? "🚨 Over 15% cap — escalation required"
      : refundPercent != null && refundPercent >= 12
      ? "⚠️ Close to 15% cap — be careful"
      : null;

  async function handleAnalyze(): Promise<void> {
    setLoading(true);
    setResult(null);
    setSaveStatus("");

    try {
     const payload = {
  rawNotes,
  issueType,
  bookingTotal: bookingTotal ? Number(bookingTotal) : null,
  refundedAmount: refundedAmount ? Number(refundedAmount) : null,

  encouragedRefundCapPercent: 15,
  maxRefundCapPercent: 20
};


      const res = await fetch(`${API_BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Server error (${res.status})`);
      }

      const data: RiskResult = await res.json();
      setResult(data);

      // Save to Firestore
      setSaveStatus("Saving to Firestore...");
      await addDoc(collection(db, "risk_analyses"), {
        createdAt: serverTimestamp(),
        agentEmail: agentEmail || "unknown",
        issueType,
        rawNotes,
        bookingTotal: toNumber(bookingTotal),
        refundedAmount: toNumber(refundedAmount),
        refundPercent,
        risk_score: data.risk_score,
        risk_level: data.risk_level,
        confidence: data.confidence,
        signals: data.signals ?? [],
        warnings: data.warnings ?? [],
        next_steps: data.next_steps ?? [],
        recommended_script: data.recommended_script ?? [],
        missing_info: data.missing_info ?? [],
        meta: data.meta ?? {},
      });

      setSaveStatus("✅ Saved to Firestore (risk_analyses).");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error occurred";
      setSaveStatus(`❌ ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  function handleClear(): void {
    setRawNotes("");
    setResult(null);
    setSaveStatus("");
    setBookingTotal("");
    setRefundedAmount("");
    setIssueType("Modification");
    setAgentEmail("");
  }

  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="fw-bold">Refund & Chargeback Risk Predictor</h1>
        <div className="text-muted">
          Notes-only analysis + 15% refund cap guardrail + Firestore audit log
        </div>
      </div>

      <div className="card shadow-sm mb-4">
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-4">
              <label className="form-label">Issue Type</label>
              <select
                className="form-select"
                value={issueType}
                onChange={(e) => setIssueType(e.target.value)}
              >
                <option>Refund</option>
                <option>Cancellation</option>
                <option>Modification</option>
                <option>Double Charge</option>
                <option>Fraud Claim</option>
                <option>Rebooking</option>
                <option>Other</option>
              </select>
            </div>

            <div className="col-md-4">
              <label className="form-label">Booking Total ($)</label>
              <input
                className="form-control"
                value={bookingTotal}
                onChange={(e) => setBookingTotal(e.target.value)}
                placeholder="e.g., 560.00"
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">Refunded Amount ($)</label>
              <input
                className="form-control"
                value={refundedAmount}
                onChange={(e) => setRefundedAmount(e.target.value)}
                placeholder="e.g., 85.06"
              />
              <div className="small text-muted mt-1">
                Refund %:{" "}
                {refundPercent == null ? "—" : `${refundPercent.toFixed(2)}%`}{" "}
                {capWarning ? <span className="ms-2">{capWarning}</span> : null}
              </div>
            </div>

            {/* ✅ This fixes your eslint error because setAgentEmail is used */}
            <div className="col-md-6">
              <label className="form-label">Agent Email (optional)</label>
              <input
                className="form-control"
                value={agentEmail}
                onChange={(e) => setAgentEmail(e.target.value)}
                placeholder="e.g., agent@company.com"
              />
            </div>

            <div className="col-12">
              <label className="form-label">Agent Notes / System Notes</label>
              <textarea
                className="form-control"
                rows={10}
                value={rawNotes}
                onChange={(e) => setRawNotes(e.target.value)}
                placeholder="Paste notes here..."
              />
            </div>

            <div className="col-12 d-flex gap-2">
              <button
                className="btn btn-primary"
                onClick={handleAnalyze}
                disabled={loading || !rawNotes.trim()}
              >
                {loading ? "Analyzing..." : "Analyze Notes"}
              </button>

              <button
                className="btn btn-outline-secondary"
                onClick={handleClear}
                disabled={loading}
              >
                Clear
              </button>
            </div>

            {saveStatus ? (
              <div className="col-12">
                <div className="alert alert-info mb-0">{saveStatus}</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {result && (
        <div className="row g-3">
          <div className="col-lg-4">
            <div className="card shadow-sm h-100">
              <div className="card-body">
                <h5 className="card-title">Risk</h5>
                <div className="display-6 fw-bold">{result.risk_score}</div>
                <div className="badge text-bg-dark">{result.risk_level}</div>
                <div className="text-muted mt-2">
                  Confidence: {Math.round(result.confidence * 100)}%
                </div>
                {result?.meta?.model ? (
                  <div className="text-muted small mt-2">
                    Model: {result.meta.model}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="col-lg-8">
            <div className="card shadow-sm mb-3">
              <div className="card-body">
                <h5 className="card-title">Top Signals</h5>
                {result.signals?.length ? (
                  <ul className="mb-0">
                    {result.signals.map((s, idx) => (
                      <li key={idx}>
                        <strong>{s.name}</strong> (weight {s.weight}) —{" "}
                        <span className="text-muted">{s.evidence_quote}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted">No signals returned.</div>
                )}
              </div>
            </div>

            <div className="card shadow-sm mb-3">
              <div className="card-body">
                <h5 className="card-title">Warnings</h5>
                {result.warnings?.length ? (
                  <ul className="mb-0">
                    {result.warnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted">None</div>
                )}
              </div>
            </div>

            <div className="card shadow-sm mb-3">
              <div className="card-body">
                <h5 className="card-title">Recommended Script</h5>
                {result.recommended_script?.length ? (
                  <ul className="mb-0">
                    {result.recommended_script.map((line, idx) => (
                      <li key={idx}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted">None</div>
                )}
              </div>
            </div>

            <div className="card shadow-sm">
              <div className="card-body">
                <h5 className="card-title">Next Steps</h5>
                {result.next_steps?.length ? (
                  <ul className="mb-0">
                    {result.next_steps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted">None</div>
                )}
              </div>
            </div>

            {result.missing_info?.length ? (
              <div className="alert alert-warning mt-3">
                <strong>Missing info:</strong> {result.missing_info.join(", ")}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
