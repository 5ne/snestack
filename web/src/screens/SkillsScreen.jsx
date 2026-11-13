import { useCallback, useEffect, useState } from "react";
import { Check, Edit3, FileText, Play, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { api } from "../api.js";
import Markdown from "../Markdown.jsx";
import ScreenHead from "../ui/ScreenHead.jsx";

function defaultSubjectForDomain(domain, presetSubject) {
  if (presetSubject) return presetSubject;
  if (domain === "financial") return "NVDA";
  if (domain === "calendar") return "today";
  if (domain === "travel") return "2025";
  return "";
}

export default function SkillsScreen({ presetSubject, onConsumePresetSubject }) {
  const [domains, setDomains] = useState([]);
  const [activeDomain, setActiveDomain] = useState("financial");
  const [includeDocs, setIncludeDocs] = useState(false);
  const [skills, setSkills] = useState([]);
  const [references, setReferences] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null); // { kind: "skill" | "ref", name }
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Reference editing
  const [editingRef, setEditingRef] = useState(false);
  const [refDraft, setRefDraft] = useState("");

  // Workbench state
  const [subject, setSubject] = useState(presetSubject || "NVDA");
  const [gatedRun, setGatedRun] = useState(false);
  const [selectedTool, setSelectedTool] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [workbenchOutput, setWorkbenchOutput] = useState(null);

  useEffect(() => {
    if (presetSubject) {
      setActiveDomain("financial");
      setSubject(presetSubject);
      onConsumePresetSubject?.();
    }
  }, [presetSubject, onConsumePresetSubject]);

  useEffect(() => {
    let cancelled = false;
    api("GET", "/api/domains")
      .then((res) => {
        if (cancelled) return;
        const list = res.domains || [];
        setDomains(list);
        if (list.length > 0 && !list.some((d) => d.name === activeDomain)) {
          setActiveDomain(list[0].name);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDomain]);

  const loadDomainItems = useCallback(async () => {
    if (!activeDomain) return;
    setLoading(true);
    setError("");
    setWorkbenchOutput(null);
    try {
      const [skillsRes, refsRes] = await Promise.all([
        api("GET", `/api/domains/${encodeURIComponent(activeDomain)}/skills`, {
          query: { all: includeDocs ? "true" : undefined },
        }),
        api("GET", `/api/domains/${encodeURIComponent(activeDomain)}/references`),
      ]);
      const nextSkills = skillsRes.skills || [];
      const nextRefs = refsRes.references || [];
      setSkills(nextSkills);
      setReferences(nextRefs);

      if (nextSkills.length > 0) {
        setSelectedItem({ kind: "skill", name: nextSkills[0].name });
      } else if (nextRefs.length > 0) {
        setSelectedItem({ kind: "ref", name: nextRefs[0] });
      } else {
        setSelectedItem(null);
        setDetail(null);
      }
      setSubject((prev) => prev || defaultSubjectForDomain(activeDomain));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [activeDomain, includeDocs]);

  useEffect(() => {
    loadDomainItems();
  }, [loadDomainItems]);

  const loadSelectedDetail = useCallback(async () => {
    if (!selectedItem || !activeDomain) return;
    setEditingRef(false);
    setError("");
    setNotice("");
    setWorkbenchOutput(null);
    try {
      if (selectedItem.kind === "skill") {
        const res = await api(
          "GET",
          `/api/domains/${encodeURIComponent(activeDomain)}/skills/${encodeURIComponent(selectedItem.name)}`
        );
        setDetail({ kind: "skill", ...res });
        const reqTools = Array.isArray(res.frontmatter?.requires) ? res.frontmatter.requires : [];
        const domObj = domains.find((d) => d.name === activeDomain);
        setSelectedTool(reqTools[0] || domObj?.contextTools?.[0] || "");
      } else {
        const res = await api(
          "GET",
          `/api/domains/${encodeURIComponent(activeDomain)}/references/${encodeURIComponent(selectedItem.name)}`
        );
        setDetail({ kind: "ref", ...res });
      }
    } catch (e) {
      setError(e.message);
    }
  }, [selectedItem, activeDomain, domains]);

  useEffect(() => {
    loadSelectedDetail();
  }, [loadSelectedDetail]);

  const handleDomainSwitch = (domName) => {
    setActiveDomain(domName);
    setSubject(defaultSubjectForDomain(domName));
  };

  const runGate = async () => {
    if (!detail || detail.kind !== "skill") return;
    setBusyAction("gate");
    setError("");
    try {
      const res = await api(
        "POST",
        `/api/domains/${encodeURIComponent(activeDomain)}/skills/${encodeURIComponent(detail.name)}/gate`,
        { body: { subject: subject.trim() } }
      );
      setWorkbenchOutput({ type: "gate", data: res });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyAction("");
    }
  };

  const runContextPreview = async () => {
    if (!selectedTool) return;
    setBusyAction("context");
    setError("");
    try {
      const res = await api(
        "GET",
        `/api/domains/${encodeURIComponent(activeDomain)}/context/${encodeURIComponent(selectedTool)}`,
        { query: { subject: subject.trim() } }
      );
      setWorkbenchOutput({ type: "context", data: res });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyAction("");
    }
  };

  const runAssemble = async () => {
    if (!detail || detail.kind !== "skill") return;
    setBusyAction("assemble");
    setError("");
    try {
      const res = await api(
        "POST",
        `/api/domains/${encodeURIComponent(activeDomain)}/skills/${encodeURIComponent(detail.name)}/assemble`,
        { body: { subject: subject.trim() } }
      );
      setWorkbenchOutput({ type: "assemble", data: res });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyAction("");
    }
  };

  const runSkillExec = async () => {
    if (!detail || detail.kind !== "skill") return;
    setBusyAction("run");
    setError("");
    try {
      const res = await api(
        "POST",
        `/api/domains/${encodeURIComponent(activeDomain)}/skills/${encodeURIComponent(detail.name)}/run`,
        { body: { subject: subject.trim(), gated: gatedRun } }
      );
      setWorkbenchOutput({ type: "run", data: res });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyAction("");
    }
  };

  const saveReference = async (e) => {
    e.preventDefault();
    if (!detail || detail.kind !== "ref") return;
    setBusyAction("save-ref");
    setError("");
    try {
      await api(
        "PUT",
        `/api/domains/${encodeURIComponent(activeDomain)}/references/${encodeURIComponent(detail.name)}`,
        { body: { content: refDraft } }
      );
      setEditingRef(false);
      setNotice(`Updated shared reference ${activeDomain}/${detail.name}.md`);
      await loadSelectedDetail();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  };

  const activeDomainObj = domains.find((d) => d.name === activeDomain);

  return (
    <div className="screen">
      <ScreenHead
        title="Skills & Domains"
        tools={
          <div className="seg" role="tablist" aria-label="Domains">
            {domains.map((d) => (
              <button
                key={d.name}
                type="button"
                aria-pressed={activeDomain === d.name}
                onClick={() => handleDomainSwitch(d.name)}
              >
                {d.name}
              </button>
            ))}
          </div>
        }
        note="Thin harness, fat markdown skills"
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeDocs}
            onChange={(e) => setIncludeDocs(e.target.checked)}
          />
          Include docs (vision / INDEX)
        </label>
      </ScreenHead>

      <div className="split-pane">
        <aside className="split-list">
          <div className="split-list-items">
            {loading ? (
              <div className="empty-state">Loading {activeDomain} skills…</div>
            ) : (
              <>
                <div className="nav-heading" style={{ margin: "6px 8px 4px" }}>
                  Skills ({skills.length})
                </div>
                {skills.map((s) => (
                  <button
                    key={`skill-${s.name}`}
                    type="button"
                    className="list-row"
                    aria-selected={selectedItem?.kind === "skill" && selectedItem?.name === s.name}
                    onClick={() => setSelectedItem({ kind: "skill", name: s.name })}
                  >
                    <Sparkles style={{ width: 14, height: 14, opacity: 0.7 }} />
                    <span className="list-row-main">
                      <span className="list-row-title">{s.name}</span>
                      <span className="list-row-sub">
                        {s.runnable ? `model: ${s.model}` : s.type || "doc"}
                        {s.hasGate ? " · gated" : ""}
                        {s.verdict ? " · verdict" : ""}
                      </span>
                    </span>
                  </button>
                ))}

                {references.length > 0 && (
                  <>
                    <div className="nav-heading" style={{ margin: "12px 8px 4px" }}>
                      Shared References ({references.length})
                    </div>
                    {references.map((r) => (
                      <button
                        key={`ref-${r}`}
                        type="button"
                        className="list-row"
                        aria-selected={selectedItem?.kind === "ref" && selectedItem?.name === r}
                        onClick={() => setSelectedItem({ kind: "ref", name: r })}
                      >
                        <FileText style={{ width: 14, height: 14, opacity: 0.7 }} />
                        <span className="list-row-main">
                          <span className="list-row-title">{r}.md</span>
                          <span className="list-row-sub">shared threshold / rubric</span>
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </aside>

        <section className="split-detail">
          {error && <div className="banner banner-err">{error}</div>}
          {notice && <div className="banner banner-ok">{notice}</div>}

          {!detail ? (
            <div className="empty-state">Select a skill or reference file on the left.</div>
          ) : detail.kind === "ref" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h3 style={{ fontSize: 17, fontWeight: 600 }} className="mono">
                  {detail.domain}/references/{detail.name}.md
                </h3>
                <span className="spacer" />
                {!editingRef && (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => {
                      setRefDraft(detail.content || "");
                      setEditingRef(true);
                    }}
                  >
                    <Edit3 /> Edit Reference
                  </button>
                )}
              </div>

              {editingRef ? (
                <form className="subcard" onSubmit={saveReference}>
                  <div className="subcard-head">Edit {detail.name}.md</div>
                  <div className="subcard-body form">
                    <textarea
                      className="control"
                      rows={16}
                      required
                      value={refDraft}
                      onChange={(e) => setRefDraft(e.target.value)}
                    />
                    <div className="actions-row" style={{ justifyContent: "flex-end" }}>
                      <button type="button" className="button" onClick={() => setEditingRef(false)}>
                        Cancel
                      </button>
                      <button type="submit" className="button button-primary" disabled={busyAction === "save-ref"}>
                        <Check /> Save Reference
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <div className="subcard">
                  <div className="subcard-head">Reference Markdown</div>
                  <div className="subcard-body">
                    <Markdown text={detail.content} />
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h3 style={{ fontSize: 17, fontWeight: 600 }} className="mono">
                  {detail.domain}/{detail.name}
                </h3>
                {detail.frontmatter?.model && <span className="pill pill-info">tier: {detail.frontmatter.model}</span>}
                {detail.frontmatter?.verdict && <span className="pill pill-ok">requires VERDICT</span>}
                {detail.frontmatter?.gate && <span className="pill pill-warn">has gate</span>}
                {(detail.frontmatter?.requires || []).map((req) => (
                  <span key={req} className="pill mono">
                    ctx:{req}
                  </span>
                ))}
              </div>

              {detail.runnable && (
                <div className="subcard">
                  <div className="subcard-head">
                    <Wrench /> Harness Workbench — Test Gate, Context, Prompt Assembly, or Execute Skill
                  </div>
                  <div className="subcard-body form">
                    <div className="actions-row">
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span className="field-label">Subject:</span>
                        <input
                          className="control control-sm mono"
                          style={{ width: 150 }}
                          value={subject}
                          onChange={(e) => setSubject(e.target.value)}
                          placeholder="e.g. NVDA, today, 2025"
                        />
                      </label>

                      {activeDomainObj?.contextTools?.length > 0 && (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <select
                            className="control control-sm"
                            value={selectedTool}
                            onChange={(e) => setSelectedTool(e.target.value)}
                          >
                            {activeDomainObj.contextTools.map((t) => (
                              <option key={t} value={t}>
                                tool: {t}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="button"
                            disabled={!subject.trim() || Boolean(busyAction)}
                            onClick={runContextPreview}
                          >
                            {busyAction === "context" ? "Fetching…" : "Preview Context"}
                          </button>
                        </div>
                      )}

                      <button
                        type="button"
                        className="button"
                        disabled={!subject.trim() || Boolean(busyAction)}
                        onClick={runGate}
                      >
                        <ShieldCheck /> {busyAction === "gate" ? "Checking…" : "Check Gate"}
                      </button>

                      <button
                        type="button"
                        className="button"
                        disabled={!subject.trim() || Boolean(busyAction)}
                        onClick={runAssemble}
                      >
                        {busyAction === "assemble" ? "Assembling…" : "Assemble Prompt"}
                      </button>

                      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={gatedRun}
                          onChange={(e) => setGatedRun(e.target.checked)}
                        />
                        Gated
                      </label>

                      <button
                        type="button"
                        className="button button-primary"
                        disabled={!subject.trim() || Boolean(busyAction)}
                        onClick={runSkillExec}
                      >
                        <Play /> {busyAction === "run" ? "Running Model…" : "Run Skill"}
                      </button>
                    </div>

                    {workbenchOutput && (
                      <div style={{ marginTop: 6 }}>
                        {workbenchOutput.type === "gate" && (
                          <div className={`banner ${workbenchOutput.data.run ? "banner-ok" : "banner-warn"}`}>
                            <div>
                              <strong>Gate decision: {workbenchOutput.data.run ? "RUN" : "SKIP"}</strong>
                              <div style={{ marginTop: 4 }}>
                                {(workbenchOutput.data.reasons || []).map((r, i) => (
                                  <div key={i}>• {r}</div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        {workbenchOutput.type === "context" && (
                          <pre className="code-box">
                            {typeof workbenchOutput.data.value === "string"
                              ? workbenchOutput.data.value
                              : JSON.stringify(workbenchOutput.data.value, null, 2)}
                          </pre>
                        )}

                        {workbenchOutput.type === "assemble" && (
                          <pre className="code-box">
                            {`=== SYSTEM PROMPT ===\n${workbenchOutput.data.systemPrompt}\n\n=== USER PROMPT ===\n${workbenchOutput.data.userPrompt}`}
                          </pre>
                        )}

                        {workbenchOutput.type === "run" && (
                          <div className="subcard">
                            <div className="subcard-head">
                              <span>
                                Execution Result ({workbenchOutput.data.status})
                              </span>
                              {workbenchOutput.data.result?.verdict && (
                                <span className="pill pill-ok">
                                  VERDICT: {workbenchOutput.data.result.verdict.label} (
                                  {Math.round(workbenchOutput.data.result.verdict.confidence * 100)}%)
                                </span>
                              )}
                              <span className="spacer" />
                              {workbenchOutput.data.result && (
                                <span className="muted mono" style={{ fontSize: 11 }}>
                                  {workbenchOutput.data.result.model} · {workbenchOutput.data.result.latencyMs}ms
                                </span>
                              )}
                            </div>
                            <div className="subcard-body">
                              {workbenchOutput.data.status === "gated" ? (
                                <div className="muted">
                                  Skipped by gate: {(workbenchOutput.data.gate?.reasons || []).join("; ")}
                                </div>
                              ) : (
                                <Markdown text={workbenchOutput.data.result?.output || ""} />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="subcard">
                <div className="subcard-head">Skill Judgment Definition ({detail.name}.md)</div>
                <div className="subcard-body">
                  <Markdown text={detail.body} />
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
