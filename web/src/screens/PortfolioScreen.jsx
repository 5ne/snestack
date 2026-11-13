import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "../api.js";
import Dialog from "../ui/Dialog.jsx";
import ScreenHead from "../ui/ScreenHead.jsx";

function fmtMoney(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export default function PortfolioScreen({ onOpenThesis, onOpenSkillForTicker }) {
  const [tab, setTab] = useState("positions");
  const [positions, setPositions] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [dump, setDump] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshTier, setRefreshTier] = useState("");

  // Dialogs
  const [addPosOpen, setAddPosOpen] = useState(false);
  const [posForm, setPosForm] = useState({ ticker: "", shares: "", costBasis: "", strategy: "long-term", notes: "" });
  const [addWatchOpen, setAddWatchOpen] = useState(false);
  const [watchForm, setWatchForm] = useState({ ticker: "", thesis: "", notes: "" });
  const [submitting, setSubmitting] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [posRes, watchRes, dumpRes] = await Promise.all([
        api("GET", "/api/domains/financial/positions"),
        api("GET", "/api/domains/financial/watchlist"),
        api("GET", "/api/domains/financial/data-dump"),
      ]);
      setPositions(posRes.positions || []);
      setWatchlist(watchRes.watchlist || []);
      setDump(dumpRes.items || []);
    } catch (e) {
      setError(e.message || "Failed to load portfolio data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const dumpByTicker = useMemo(() => {
    const map = {};
    for (const item of dump) {
      map[item.ticker] = item;
    }
    return map;
  }, [dump]);

  const summary = useMemo(() => {
    let totalCost = 0;
    let totalValue = 0;
    let pricedCount = 0;
    for (const p of positions) {
      const shares = Number(p.shares) || 0;
      const basis = Number(p.cost_basis) || 0;
      totalCost += shares * basis;
      const close = dumpByTicker[p.ticker]?.quote?.close;
      if (Number.isFinite(Number(close))) {
        totalValue += shares * Number(close);
        pricedCount++;
      } else {
        totalValue += shares * basis;
      }
    }
    const pnl = totalValue - totalCost;
    const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : null;
    const flaggedCount = dump.filter((d) => d.data_quality && !d.data_quality.ok).length;
    return {
      totalCost,
      totalValue,
      pricedCount,
      pnl,
      pnlPct,
      flaggedCount,
    };
  }, [positions, dumpByTicker, dump]);

  const triggerDataRefresh = async (tier) => {
    setRefreshTier(tier);
    setError("");
    setNotice("");
    try {
      const res = await api("POST", "/api/domains/financial/data-refresh", { body: { tier } });
      const failNote = res.failed?.length ? ` (${res.failed.length} failed: ${res.failed.join(", ")})` : "";
      setNotice(`Refreshed ${res.tickers?.length ?? 0} ticker(s) at ${tier} tier${failNote}.`);
      await loadAll();
    } catch (e) {
      setError(e.message || `data-refresh (${tier}) failed`);
    } finally {
      setRefreshTier("");
    }
  };

  const handleStrategyChange = async (ticker, strategy) => {
    setError("");
    try {
      await api("PATCH", `/api/domains/financial/positions/${encodeURIComponent(ticker)}/strategy`, {
        body: { strategy },
      });
      setPositions((prev) => prev.map((p) => (p.ticker === ticker ? { ...p, strategy } : p)));
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRemovePosition = async (ticker) => {
    if (!window.confirm(`Remove position ${ticker}?`)) return;
    setError("");
    try {
      await api("DELETE", `/api/domains/financial/positions/${encodeURIComponent(ticker)}`);
      await loadAll();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRemoveWatchlist = async (ticker) => {
    if (!window.confirm(`Remove ${ticker} from watchlist?`)) return;
    setError("");
    try {
      await api("DELETE", `/api/domains/financial/watchlist/${encodeURIComponent(ticker)}`);
      await loadAll();
    } catch (e) {
      setError(e.message);
    }
  };

  const submitPosition = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api("POST", "/api/domains/financial/positions", {
        body: {
          ticker: posForm.ticker.trim().toUpperCase(),
          shares: Number(posForm.shares),
          costBasis: Number(posForm.costBasis),
          strategy: posForm.strategy,
          notes: posForm.notes.trim() || undefined,
        },
      });
      setAddPosOpen(false);
      setPosForm({ ticker: "", shares: "", costBasis: "", strategy: "long-term", notes: "" });
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitWatchlist = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api("POST", "/api/domains/financial/watchlist", {
        body: {
          ticker: watchForm.ticker.trim().toUpperCase(),
          thesis: watchForm.thesis.trim(),
          notes: watchForm.notes.trim() || undefined,
        },
      });
      setAddWatchOpen(false);
      setWatchForm({ ticker: "", thesis: "", notes: "" });
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="screen">
      <ScreenHead
        title="Portfolio"
        tools={
          <div className="seg" role="tablist" aria-label="Portfolio views">
            <button type="button" aria-pressed={tab === "positions"} onClick={() => setTab("positions")}>
              Positions ({positions.length})
            </button>
            <button type="button" aria-pressed={tab === "watchlist"} onClick={() => setTab("watchlist")}>
              Watchlist ({watchlist.length})
            </button>
            <button type="button" aria-pressed={tab === "cache"} onClick={() => setTab("cache")}>
              Market & Quality ({dump.length})
            </button>
          </div>
        }
      >
        <div className="actions-row">
          <button
            type="button"
            className="button"
            disabled={Boolean(refreshTier)}
            onClick={() => triggerDataRefresh("intraday")}
            title="Fetch latest quotes & technicals for tracked tickers"
          >
            <RefreshCw className={refreshTier ? "spin" : ""} />
            {refreshTier ? `Refreshing (${refreshTier})…` : "Refresh Quotes"}
          </button>
          <button type="button" className="button" onClick={() => setAddWatchOpen(true)}>
            <Plus /> Watchlist
          </button>
          <button type="button" className="button button-primary" onClick={() => setAddPosOpen(true)}>
            <Plus /> Position
          </button>
        </div>
      </ScreenHead>

      <div className="screen-body">
        <div className="screen-pad">
          {error && <div className="banner banner-err">{error}</div>}
          {notice && <div className="banner banner-ok">{notice}</div>}

          <div className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Market Value</span>
              <span className="kpi-value">{fmtMoney(summary.totalValue)}</span>
              <span className="kpi-sub">
                {summary.pricedCount}/{positions.length} priced from cached quotes
              </span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Cost Basis</span>
              <span className="kpi-value">{fmtMoney(summary.totalCost)}</span>
              <span className="kpi-sub">{positions.length} held positions</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Unrealized P&amp;L</span>
              <span className={`kpi-value ${summary.pnl >= 0 ? "gain-pos" : "gain-neg"}`}>
                {fmtMoney(summary.pnl)} ({fmtPct(summary.pnlPct)})
              </span>
              <span className="kpi-sub">vs. recorded cost basis</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Data Quality</span>
              <span className="kpi-value">
                {summary.flaggedCount === 0 ? "All clean" : `${summary.flaggedCount} flagged`}
              </span>
              <span className="kpi-sub">{watchlist.length} watchlist candidates</span>
            </div>
          </div>

          {loading ? (
            <div className="empty-state">Loading portfolio &amp; cached market data…</div>
          ) : tab === "positions" ? (
            positions.length === 0 ? (
              <div className="empty-state">
                <p>No portfolio positions recorded yet.</p>
                <button type="button" className="button button-primary" onClick={() => setAddPosOpen(true)}>
                  <Plus /> Add first position
                </button>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th className="num">Shares</th>
                      <th className="num">Avg Cost</th>
                      <th className="num">Last Close</th>
                      <th className="num">Market Value</th>
                      <th className="num">Return</th>
                      <th className="num">RSI-14</th>
                      <th>Strategy</th>
                      <th>Quality</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const d = dumpByTicker[p.ticker];
                      const close = d?.quote?.close ?? null;
                      const rsi = d?.quote?.rsi ?? null;
                      const shares = Number(p.shares);
                      const basis = Number(p.cost_basis);
                      const mktVal = close !== null ? shares * Number(close) : null;
                      const retPct = close !== null && basis > 0 ? ((Number(close) - basis) / basis) * 100 : null;
                      const flags = d?.data_quality?.flags || [];
                      return (
                        <tr key={p.ticker}>
                          <td>
                            <button
                              type="button"
                              className="ticker-btn"
                              onClick={() => onOpenThesis?.(p.ticker)}
                              title={`Open ${p.ticker} thesis note`}
                            >
                              {p.ticker}
                            </button>
                          </td>
                          <td className="num">{shares}</td>
                          <td className="num">{fmtMoney(basis)}</td>
                          <td className="num">{close !== null ? fmtMoney(close) : "—"}</td>
                          <td className="num">{mktVal !== null ? fmtMoney(mktVal) : "—"}</td>
                          <td className={`num ${retPct === null ? "" : retPct >= 0 ? "gain-pos" : "gain-neg"}`}>
                            {fmtPct(retPct)}
                          </td>
                          <td className="num">{rsi !== null && rsi !== undefined ? Number(rsi).toFixed(1) : "—"}</td>
                          <td>
                            <select
                              className="control control-sm"
                              aria-label={`Strategy for ${p.ticker}`}
                              value={p.strategy || "long-term"}
                              onChange={(e) => handleStrategyChange(p.ticker, e.target.value)}
                            >
                              <option value="long-term">long-term</option>
                              <option value="swing">swing</option>
                              <option value="both">both</option>
                            </select>
                          </td>
                          <td>
                            {flags.length === 0 ? (
                              <span className="pill pill-ok">
                                <CheckCircle2 style={{ width: 12, height: 12 }} /> clean
                              </span>
                            ) : (
                              <span className="pill pill-warn" title={flags.map((f) => f.message).join("\n")}>
                                <AlertTriangle style={{ width: 12, height: 12 }} /> {flags.length} flag
                                {flags.length > 1 ? "s" : ""}
                              </span>
                            )}
                          </td>
                          <td>
                            <div className="actions-row">
                              <button
                                type="button"
                                className="button button-ghost"
                                title={`Run skill on ${p.ticker}`}
                                onClick={() => onOpenSkillForTicker?.(p.ticker)}
                              >
                                Analyze <ArrowUpRight style={{ width: 13, height: 13 }} />
                              </button>
                              <button
                                type="button"
                                className="button button-ghost button-icon button-danger"
                                aria-label={`Remove ${p.ticker}`}
                                title={`Remove ${p.ticker}`}
                                onClick={() => handleRemovePosition(p.ticker)}
                              >
                                <Trash2 />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : tab === "watchlist" ? (
            watchlist.length === 0 ? (
              <div className="empty-state">
                <p>Your watchlist is empty.</p>
                <button type="button" className="button button-primary" onClick={() => setAddWatchOpen(true)}>
                  <Plus /> Add ticker to watchlist
                </button>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th className="num">Last Close</th>
                      <th className="num">Fair Value</th>
                      <th>Moat</th>
                      <th>Watchlist Thesis</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watchlist.map((w) => {
                      const d = dumpByTicker[w.ticker];
                      const close = d?.quote?.close ?? null;
                      const fv = d?.equity?.fairValue ?? null;
                      const moat = d?.equity?.economicMoat ?? null;
                      return (
                        <tr key={w.ticker}>
                          <td>
                            <button
                              type="button"
                              className="ticker-btn"
                              onClick={() => onOpenThesis?.(w.ticker)}
                              title={`Open ${w.ticker} thesis note`}
                            >
                              {w.ticker}
                            </button>
                          </td>
                          <td className="num">{close !== null ? fmtMoney(close) : "—"}</td>
                          <td className="num">{fv !== null ? fmtMoney(fv) : "—"}</td>
                          <td>{moat ? <span className="pill">{moat}</span> : <span className="muted">—</span>}</td>
                          <td>{w.thesis}</td>
                          <td>
                            <div className="actions-row">
                              <button
                                type="button"
                                className="button button-ghost"
                                onClick={() => onOpenSkillForTicker?.(w.ticker)}
                              >
                                Analyze <ArrowUpRight style={{ width: 13, height: 13 }} />
                              </button>
                              <button
                                type="button"
                                className="button button-ghost button-icon button-danger"
                                aria-label={`Remove ${w.ticker}`}
                                onClick={() => handleRemoveWatchlist(w.ticker)}
                              >
                                <Trash2 />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="subcard">
              <div className="subcard-head">
                <span>Cached Market &amp; Morningstar Snapshot</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="button"
                  disabled={Boolean(refreshTier)}
                  onClick={() => triggerDataRefresh("daily")}
                >
                  Daily Refresh
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={Boolean(refreshTier)}
                  onClick={() => triggerDataRefresh("weekly")}
                >
                  Weekly Refresh (Morningstar PDFs)
                </button>
              </div>
              <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Universe</th>
                      <th className="num">Close</th>
                      <th className="num">RSI</th>
                      <th className="num">Fair Value</th>
                      <th className="num">P / FV</th>
                      <th>Moat</th>
                      <th>Stars</th>
                      <th>Data Quality Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dump.map((d) => {
                      const flags = d.data_quality?.flags || [];
                      return (
                        <tr key={d.ticker}>
                          <td>
                            <button type="button" className="ticker-btn" onClick={() => onOpenThesis?.(d.ticker)}>
                              {d.ticker}
                            </button>
                          </td>
                          <td>
                            {d.isPosition && <span className="pill pill-info">position</span>}{" "}
                            {d.isWatchlist && <span className="pill">watchlist</span>}
                          </td>
                          <td className="num">{d.quote?.close != null ? fmtMoney(d.quote.close) : "—"}</td>
                          <td className="num">{d.quote?.rsi != null ? Number(d.quote.rsi).toFixed(1) : "—"}</td>
                          <td className="num">{d.equity?.fairValue != null ? fmtMoney(d.equity.fairValue) : "—"}</td>
                          <td className="num">
                            {d.equity?.priceToFairValue != null ? Number(d.equity.priceToFairValue).toFixed(2) : "—"}
                          </td>
                          <td>{d.equity?.economicMoat || "—"}</td>
                          <td className="mono">
                            {d.equity?.morningstarRating ? "★".repeat(Number(d.equity.morningstarRating)) : "—"}
                          </td>
                          <td>
                            {flags.length === 0 ? (
                              <span className="pill pill-ok">clean</span>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                {flags.map((f, idx) => (
                                  <span key={idx} className="muted" style={{ fontSize: 11 }}>
                                    • {f.message}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog open={addPosOpen} onClose={() => setAddPosOpen(false)} title="Add or Update Position">
        <form className="form" onSubmit={submitPosition}>
          <div className="form-row">
            <label className="field">
              <span className="field-label">Ticker</span>
              <input
                className="control"
                required
                placeholder="NVDA"
                value={posForm.ticker}
                onChange={(e) => setPosForm({ ...posForm, ticker: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Strategy</span>
              <select
                className="control"
                value={posForm.strategy}
                onChange={(e) => setPosForm({ ...posForm, strategy: e.target.value })}
              >
                <option value="long-term">long-term</option>
                <option value="swing">swing</option>
                <option value="both">both</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span className="field-label">Shares</span>
              <input
                className="control"
                type="number"
                step="any"
                required
                placeholder="25"
                value={posForm.shares}
                onChange={(e) => setPosForm({ ...posForm, shares: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Avg Cost Basis ($)</span>
              <input
                className="control"
                type="number"
                step="any"
                required
                placeholder="118.50"
                value={posForm.costBasis}
                onChange={(e) => setPosForm({ ...posForm, costBasis: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Notes (optional)</span>
            <input
              className="control"
              placeholder="Core compounder sleeve"
              value={posForm.notes}
              onChange={(e) => setPosForm({ ...posForm, notes: e.target.value })}
            />
          </label>
          <div className="actions-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="button" onClick={() => setAddPosOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? "Saving…" : "Save Position"}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog open={addWatchOpen} onClose={() => setAddWatchOpen(false)} title="Add Watchlist Candidate">
        <form className="form" onSubmit={submitWatchlist}>
          <label className="field">
            <span className="field-label">Ticker</span>
            <input
              className="control"
              required
              placeholder="COST"
              value={watchForm.ticker}
              onChange={(e) => setWatchForm({ ...watchForm, ticker: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Watchlist Thesis</span>
            <input
              className="control"
              required
              placeholder="Membership renewal moat; waiting for P/FV <= 0.95"
              value={watchForm.thesis}
              onChange={(e) => setWatchForm({ ...watchForm, thesis: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Notes (optional)</span>
            <input
              className="control"
              placeholder="Target entry price or catalyst"
              value={watchForm.notes}
              onChange={(e) => setWatchForm({ ...watchForm, notes: e.target.value })}
            />
          </label>
          <div className="actions-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="button" onClick={() => setAddWatchOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? "Saving…" : "Save to Watchlist"}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
