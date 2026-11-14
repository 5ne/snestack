import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api.js";
import ScreenHead from "../ui/ScreenHead.jsx";

function verdictPillClass(rec) {
  const r = String(rec || "").toUpperCase();
  if (r === "BUY") return "pill pill-buy";
  if (r === "SELL") return "pill pill-sell";
  return "pill pill-hold";
}

function fmtDate(raw) {
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function SignalsScreen({ onOpenThesis }) {
  const [signals, setSignals] = useState([]);
  const [tickerFilter, setTickerFilter] = useState("");
  const [days, setDays] = useState("30");
  const [verdictFilter, setVerdictFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadSignals = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api("GET", "/api/domains/financial/signals", {
        query: {
          ticker: tickerFilter.trim().toUpperCase() || undefined,
          days,
          limit: 100,
        },
      });
      setSignals(res.signals || []);
    } catch (e) {
      setError(e.message || "Failed to load signals");
    } finally {
      setLoading(false);
    }
  }, [tickerFilter, days]);

  useEffect(() => {
    loadSignals();
  }, [loadSignals]);

  const filtered = useMemo(() => {
    if (verdictFilter === "ALL") return signals;
    return signals.filter((s) => String(s.recommendation || "").toUpperCase() === verdictFilter);
  }, [signals, verdictFilter]);

  return (
    <div className="screen">
      <ScreenHead
        title="Signals"
        tools={
          <div className="seg" role="group" aria-label="Filter by recommendation">
            {["ALL", "BUY", "SELL", "HOLD"].map((v) => (
              <button key={v} type="button" aria-pressed={verdictFilter === v} onClick={() => setVerdictFilter(v)}>
                {v}
              </button>
            ))}
          </div>
        }
        note={`${filtered.length} recorded recommendations`}
      >
        <div className="actions-row">
          <input
            className="control control-sm"
            style={{ width: 110 }}
            placeholder="Ticker…"
            value={tickerFilter}
            onChange={(e) => setTickerFilter(e.target.value)}
          />
          <select className="control control-sm" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="7">Last 7d</option>
            <option value="30">Last 30d</option>
            <option value="90">Last 90d</option>
            <option value="365">Last 365d</option>
          </select>
          <button type="button" className="button" onClick={loadSignals} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} /> Refresh
          </button>
        </div>
      </ScreenHead>

      <div className="screen-body">
        <div className="screen-pad">
          {error && <div className="banner banner-err">{error}</div>}
          {loading ? (
            <div className="empty-state">Loading signal history…</div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">No signals match the selected filters.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Ticker</th>
                    <th>Verdict</th>
                    <th className="num">Confidence</th>
                    <th>Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s, idx) => {
                    const fromWatch = Boolean(s.from_watchlist ?? s.fromWatchlist);
                    const conf = Number(s.confidence);
                    return (
                      <tr key={s.id ?? `${s.ticker}-${idx}`}>
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>
                          {fmtDate(s.date || s.created_at)}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button type="button" className="ticker-btn" onClick={() => onOpenThesis?.(s.ticker)}>
                            {s.ticker}
                          </button>{" "}
                          {fromWatch && <span className="pill">watchlist</span>}
                        </td>
                        <td>
                          <span className={verdictPillClass(s.recommendation)}>{s.recommendation}</span>
                        </td>
                        <td className="num">
                          {Number.isFinite(conf) ? `${Math.round(conf * 100)}%` : "—"}
                        </td>
                        <td style={{ minWidth: 320 }}>{s.reasoning}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
