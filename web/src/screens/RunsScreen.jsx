import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import ScreenHead from "../ui/ScreenHead.jsx";

function statusPill(status) {
  if (status === "ok") return "pill pill-ok";
  if (status === "degraded") return "pill pill-warn";
  return "pill pill-err";
}

function fmtSec(ms) {
  if (ms === null || ms === undefined) return "—";
  return `${(Number(ms) / 1000).toFixed(1)}s`;
}

export default function RunsScreen() {
  const [tab, setTab] = useState("runs");
  const [runs, setRuns] = useState([]);
  const [includeDryRun, setIncludeDryRun] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [runReport, setRunReport] = useState(null);
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [runsRes, checkRes, statsRes] = await Promise.all([
        api("GET", "/api/runs", { query: { limit: 40, includeDryRun: includeDryRun ? "true" : undefined } }),
        api("GET", "/api/runs/check"),
        api("GET", "/api/runs/stats"),
      ]);
      const list = runsRes.runs || [];
      setRuns(list);
      setHealth(checkRes);
      setStats(statsRes);
      if (list.length > 0 && !selectedRun) {
        setSelectedRun(list[0]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [includeDryRun, selectedRun]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedRun?.dir) {
      setRunReport(null);
      return;
    }
    let cancelled = false;
    api("GET", "/api/runs/report", { query: { dir: selectedRun.dir } })
      .then((res) => {
        if (!cancelled) setRunReport(res);
      })
      .catch(() => {
        if (!cancelled) setRunReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRun]);

  const findingsCount = health?.findings?.length ?? 0;

  return (
    <div className="screen">
      <ScreenHead
        title="Automation Runs & Health"
        tools={
          <div className="seg" role="tablist" aria-label="Runs views">
            <button type="button" aria-pressed={tab === "runs"} onClick={() => setTab("runs")}>
              Recent Runs ({runs.length})
            </button>
            <button type="button" aria-pressed={tab === "health"} onClick={() => setTab("health")}>
              Health Check ({findingsCount === 0 ? "OK" : `${findingsCount} issue${findingsCount > 1 ? "s" : ""}`})
            </button>
            <button type="button" aria-pressed={tab === "stats"} onClick={() => setTab("stats")}>
              Cost &amp; Gate Stats
            </button>
          </div>
        }
      >
        <div className="actions-row">
          {tab === "runs" && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={includeDryRun}
                onChange={(e) => setIncludeDryRun(e.target.checked)}
              />
              Include dry-runs
            </label>
          )}
          <button type="button" className="button" onClick={loadAll} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} /> Refresh
          </button>
        </div>
      </ScreenHead>

      {tab === "runs" ? (
        <div className="split-pane">
          <aside className="split-list">
            <div className="split-list-items">
              {loading ? (
                <div className="empty-state">Loading runs…</div>
              ) : runs.length === 0 ? (
                <div className="empty-state">No automation run logs found in &lt;brain&gt;.</div>
              ) : (
                runs.map((r) => (
                  <button
                    key={r.dir}
                    type="button"
                    className="list-row"
                    aria-selected={selectedRun?.dir === r.dir}
                    onClick={() => setSelectedRun(r)}
                  >
                    <span
                      className={`status-dot ${
                        r.summary?.status === "ok"
                          ? "status-dot-ok"
                          : r.summary?.status === "degraded"
                            ? "status-dot-warn"
                            : "status-dot-err"
                      }`}
                    />
                    <span className="list-row-main">
                      <span className="list-row-title">{r.script}</span>
                      <span className="list-row-sub">
                        {r.date} · {r.domain} · {r.summary?.steps?.ok ?? 0}/{r.summary?.steps?.total ?? 0} steps
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="split-detail">
            {error && <div className="banner banner-err">{error}</div>}
            {!selectedRun ? (
              <div className="empty-state">Select an automation run on the left to inspect its telemetry.</div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <h3 style={{ fontSize: 17, fontWeight: 600 }} className="mono">
                    {selectedRun.script}
                  </h3>
                  <span className={statusPill(selectedRun.summary?.status)}>{selectedRun.summary?.status}</span>
                  <span className="pill">{selectedRun.domain}</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {selectedRun.date} · {fmtSec(selectedRun.summary?.duration_ms)}
                  </span>
                </div>

                <div className="kpi-grid">
                  <div className="kpi-card">
                    <span className="kpi-label">Steps</span>
                    <span className="kpi-value">
                      {selectedRun.summary?.steps?.ok ?? 0} / {selectedRun.summary?.steps?.total ?? 0}
                    </span>
                    <span className="kpi-sub">
                      {selectedRun.summary?.steps?.skipped ?? 0} skipped · {selectedRun.summary?.steps?.failed ?? 0} failed
                    </span>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-label">Model Calls</span>
                    <span className="kpi-value">{selectedRun.summary?.model_calls?.count ?? 0}</span>
                    <span className="kpi-sub">
                      {(selectedRun.summary?.model_calls?.input_tokens ?? 0).toLocaleString()} in ·{" "}
                      {(selectedRun.summary?.model_calls?.output_tokens ?? 0).toLocaleString()} out
                    </span>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-label">Metered Spend</span>
                    <span className="kpi-value">
                      {selectedRun.summary?.model_calls?.est_cost_usd != null
                        ? `$${Number(selectedRun.summary.model_calls.est_cost_usd).toFixed(4)}`
                        : "$0.00"}
                    </span>
                    <span className="kpi-sub">
                      API equiv:{" "}
                      {selectedRun.summary?.model_calls?.api_equivalent_usd != null
                        ? `$${Number(selectedRun.summary.model_calls.api_equivalent_usd).toFixed(3)}`
                        : "—"}
                    </span>
                  </div>
                </div>

                {selectedRun.summary?.failed_steps?.length > 0 && (
                  <div className="banner banner-err">
                    <div>
                      <strong>Failed Steps</strong>
                      {selectedRun.summary.failed_steps.map((fs, i) => (
                        <div key={i} className="mono" style={{ marginTop: 4 }}>
                          • {fs.step} {fs.subject ? `(${fs.subject})` : ""}: {fs.error || `exit ${fs.exit_code}`}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {runReport?.text && (
                  <div className="subcard">
                    <div className="subcard-head">Formatted Run Report ({selectedRun.dir})</div>
                    <div className="subcard-body">
                      <pre className="code-box">{runReport.text}</pre>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      ) : tab === "health" ? (
        <div className="screen-body">
          <div className="screen-pad">
            {error && <div className="banner banner-err">{error}</div>}
            {!health ? (
              <div className="empty-state">Checking automation health…</div>
            ) : health.ok ? (
              <div className="banner banner-ok">
                <CheckCircle2 /> All scheduled runs, caches, and thesis checks passed ({health.date}).
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Code</th>
                      <th>Target</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(health.findings || []).map((f, idx) => (
                      <tr key={idx}>
                        <td>
                          <span className={f.severity === "error" ? "pill pill-err" : "pill pill-warn"}>
                            <AlertTriangle style={{ width: 11, height: 11 }} /> {f.severity}
                          </span>
                        </td>
                        <td className="mono">{f.code}</td>
                        <td className="mono">{f.script || f.domain || "core"}</td>
                        <td>{f.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="screen-body">
          <div className="screen-pad">
            {error && <div className="banner banner-err">{error}</div>}
            {!stats ? (
              <div className="empty-state">Computing 7d / 30d stats…</div>
            ) : (
              <>
                {(stats.scripts || []).length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Domain</th>
                          <th>Automation Script</th>
                          <th>Window</th>
                          <th className="num">Runs</th>
                          <th className="num">Model Calls</th>
                          <th className="num">Gate Skip %</th>
                          <th className="num">Redundancy %</th>
                          <th className="num">Metered Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.scripts.flatMap((sc) =>
                          (sc.windows || []).map((w) => (
                            <tr key={`${sc.domain}-${sc.script}-${w.days}`}>
                              <td>
                                <span className="pill">{sc.domain}</span>
                              </td>
                              <td className="mono">{sc.script}</td>
                              <td>{w.days}d</td>
                              <td className="num">{w.runs}</td>
                              <td className="num">{w.model_calls}</td>
                              <td className="num">
                                {w.gate_skip_ratio != null ? `${Math.round(w.gate_skip_ratio * 100)}%` : "—"}
                              </td>
                              <td className="num">
                                {w.redundancy_ratio != null ? `${Math.round(w.redundancy_ratio * 100)}%` : "—"}
                              </td>
                              <td className="num">${Number(w.cost_usd || 0).toFixed(3)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {stats.formatted && (
                  <div className="subcard">
                    <div className="subcard-head">CLI Parity Rollup (`snestack run-stats`)</div>
                    <div className="subcard-body">
                      <pre className="code-box">{stats.formatted}</pre>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
