import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Play, RefreshCw, XCircle } from "lucide-react";
import { api, getToken, setToken } from "../api.js";
import ScreenHead from "../ui/ScreenHead.jsx";

export default function SystemScreen({ onTokenSaved }) {
  const [envInfo, setEnvInfo] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [scopeFilter, setScopeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [tokenInput, setTokenInput] = useState(getToken);
  const [tokenSavedMsg, setTokenSavedMsg] = useState("");
  const [smokeRes, setSmokeRes] = useState(null);
  const [smoking, setSmoking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadSystem = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [eRes, rRes] = await Promise.all([api("GET", "/api/env"), api("GET", "/api/routes")]);
      setEnvInfo(eRes);
      setRoutes(rRes.routes || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSystem();
  }, [loadSystem]);

  const handleSaveToken = (e) => {
    e.preventDefault();
    setToken(tokenInput);
    setTokenSavedMsg(tokenInput.trim() ? "Bearer token saved to browser storage." : "Bearer token cleared.");
    onTokenSaved?.();
    loadSystem();
  };

  const runExecutorSmoke = async () => {
    setSmoking(true);
    setError("");
    setSmokeRes(null);
    try {
      const res = await api("POST", "/api/executor/check", { body: { tier: "cheap" } });
      setSmokeRes(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setSmoking(false);
    }
  };

  const scopes = ["all", ...Array.from(new Set(routes.map((r) => r.scope)))];
  const filteredRoutes = routes.filter((r) => {
    if (scopeFilter !== "all" && r.scope !== scopeFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return r.pattern.toLowerCase().includes(q) || r.summary.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="screen">
      <ScreenHead title="System & Isomorphic API" note={`${routes.length} shared CLI / HTTP endpoints`}>
        <div className="actions-row">
          <button type="button" className="button" onClick={runExecutorSmoke} disabled={smoking}>
            <Play /> {smoking ? "Testing Executor…" : "Smoke-Test Executor"}
          </button>
          <button type="button" className="button" onClick={loadSystem} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} /> Refresh
          </button>
        </div>
      </ScreenHead>

      <div className="screen-body">
        <div className="screen-pad">
          {error && <div className="banner banner-err">{error}</div>}
          {tokenSavedMsg && <div className="banner banner-ok">{tokenSavedMsg}</div>}
          {smokeRes && (
            <div className="banner banner-ok">
              Executor OK: backend <code>{smokeRes.backend}</code> ({smokeRes.model}) replied &ldquo;{smokeRes.reply}
              &rdquo; in {smokeRes.latencyMs}ms.
            </div>
          )}

          <div className="subcard">
            <div className="subcard-head">
              <KeyRound /> API Bearer Token (`SNESTACK_API_TOKEN`)
            </div>
            <div className="subcard-body">
              <form className="actions-row" onSubmit={handleSaveToken}>
                <input
                  type="password"
                  className="control control-sm mono"
                  style={{ flex: 1, minWidth: 240 }}
                  placeholder="Optional on 127.0.0.1; required for remote / Cloud Run"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
                <button type="submit" className="button button-primary">
                  Save Token
                </button>
                {tokenInput && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setTokenInput("");
                      setToken("");
                      setTokenSavedMsg("Cleared stored Bearer token.");
                      onTokenSaved?.();
                    }}
                  >
                    Clear
                  </button>
                )}
              </form>
            </div>
          </div>

          {envInfo && (
            <div className="subcard">
              <div className="subcard-head">
                <span>Environment Readiness</span>
                <span className={`pill ${envInfo.valid ? "pill-ok" : "pill-warn"}`}>
                  {envInfo.valid ? "Ready" : `Missing: ${envInfo.missingRequired.join(", ")}`}
                </span>
                <span className="spacer" />
                <span className="muted mono" style={{ fontSize: 11 }}>
                  Executor: {envInfo.executorChain}
                </span>
              </div>
              <div className="subcard-body">
                <div className="kpi-grid">
                  {Object.entries(envInfo.configured || {}).map(([key, ok]) => (
                    <div
                      key={key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        borderRadius: 8,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {ok ? (
                        <CheckCircle2 style={{ color: "var(--success)" }} />
                      ) : (
                        <XCircle style={{ color: "var(--text-muted)" }} />
                      )}
                      <span className="mono">{key}</span>
                    </div>
                  ))}
                </div>
                <div className="muted mono" style={{ marginTop: 10, fontSize: 11 }}>
                  SNESTACK_BRAIN_ROOT: {envInfo.brainRoot} ({envInfo.brainRootExists ? "mounted" : "not found"})
                </div>
              </div>
            </div>
          )}

          <div className="subcard">
            <div className="subcard-head">
              <span>Isomorphic Route Table</span>
              <div className="seg" role="group" aria-label="Route scope">
                {scopes.map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    aria-pressed={scopeFilter === sc}
                    onClick={() => setScopeFilter(sc)}
                  >
                    {sc}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              <input
                className="control control-sm"
                style={{ width: 190 }}
                placeholder="Search routes…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRoutes.map((r) => (
                    <tr key={`${r.method}-${r.pattern}`}>
                      <td>
                        <span className="pill">{r.scope}</span>
                      </td>
                      <td>
                        <span
                          className={`pill mono ${
                            r.method === "GET"
                              ? "pill-info"
                              : r.method === "DELETE"
                                ? "pill-err"
                                : "pill-ok"
                          }`}
                        >
                          {r.method}
                        </span>
                      </td>
                      <td className="mono">{r.pattern}</td>
                      <td className="muted">{r.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
