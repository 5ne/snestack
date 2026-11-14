import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check, Edit3, RefreshCw, Search } from "lucide-react";
import { api } from "../api.js";
import Markdown from "../Markdown.jsx";
import ScreenHead from "../ui/ScreenHead.jsx";

export default function ThesesScreen({ initialTicker }) {
  const [report, setReport] = useState(null);
  const [filter, setFilter] = useState("all");
  const [customTicker, setCustomTicker] = useState("");
  const [selectedTicker, setSelectedTicker] = useState(initialTicker || "");
  const [detail, setDetail] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editMode, setEditMode] = useState("thesis"); // "thesis" | "raw"
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (initialTicker) setSelectedTicker(initialTicker);
  }, [initialTicker]);

  const loadCoverage = useCallback(async () => {
    setLoadingList(true);
    setError("");
    try {
      const res = await api("GET", "/api/domains/financial/theses");
      setReport(res);
      if (!selectedTicker && res.items?.length) {
        setSelectedTicker(res.items[0].ticker);
      }
    } catch (e) {
      setError(e.message || "Failed to load thesis coverage");
    } finally {
      setLoadingList(false);
    }
  }, [selectedTicker]);

  useEffect(() => {
    loadCoverage();
  }, [loadCoverage]);

  const loadDetail = useCallback(async (ticker) => {
    if (!ticker) return;
    setLoadingDetail(true);
    setEditing(false);
    setError("");
    setNotice("");
    try {
      const res = await api("GET", `/api/domains/financial/theses/${encodeURIComponent(ticker)}`);
      setDetail(res);
    } catch (e) {
      setError(e.message || `Failed to load thesis for ${ticker}`);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    if (selectedTicker) loadDetail(selectedTicker);
  }, [selectedTicker, loadDetail]);

  const startEditing = (mode = "thesis") => {
    setEditMode(mode);
    if (mode === "raw") {
      setDraftText(detail?.content || "");
    } else {
      setDraftText(detail?.extractedThesis || "");
    }
    setEditing(true);
    setNotice("");
  };

  const saveThesis = async (e) => {
    e.preventDefault();
    if (!selectedTicker) return;
    setSaving(true);
    setError("");
    try {
      const body = editMode === "raw" ? { content: draftText } : { thesis: draftText };
      await api("PUT", `/api/domains/financial/theses/${encodeURIComponent(selectedTicker)}`, { body });
      setEditing(false);
      setNotice(`Saved thesis note for ${selectedTicker} in <brain>.`);
      await Promise.all([loadCoverage(), loadDetail(selectedTicker)]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const items = (report?.items || []).filter((it) => {
    if (filter === "covered") return it.hasThesis;
    if (filter === "uncovered") return !it.hasThesis;
    return true;
  });

  const handleCustomInspect = (e) => {
    e.preventDefault();
    const sym = customTicker.trim().toUpperCase();
    if (sym) {
      setSelectedTicker(sym);
      setCustomTicker("");
    }
  };

  return (
    <div className="screen">
      <ScreenHead
        title="Company Theses"
        tools={
          <div className="seg" role="group" aria-label="Thesis filter">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All ({report?.total ?? 0})
            </button>
            <button type="button" aria-pressed={filter === "covered"} onClick={() => setFilter("covered")}>
              Covered ({report?.covered?.length ?? 0})
            </button>
            <button type="button" aria-pressed={filter === "uncovered"} onClick={() => setFilter("uncovered")}>
              Needs Thesis ({report?.uncovered?.length ?? 0})
            </button>
          </div>
        }
        note="Durable owner notes in <brain>/financial/brain/investing/public/companies/"
      >
        <button type="button" className="button" onClick={loadCoverage} disabled={loadingList}>
          <RefreshCw className={loadingList ? "spin" : ""} /> Refresh
        </button>
      </ScreenHead>

      <div className="split-pane">
        <aside className="split-list">
          <form className="split-list-head" onSubmit={handleCustomInspect}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="control control-sm"
                style={{ flex: 1 }}
                placeholder="Inspect ticker (e.g. BRK.B)…"
                value={customTicker}
                onChange={(e) => setCustomTicker(e.target.value)}
              />
              <button type="submit" className="button button-icon" title="Inspect ticker">
                <Search />
              </button>
            </div>
          </form>
          <div className="split-list-items">
            {loadingList ? (
              <div className="empty-state">Loading tickers…</div>
            ) : items.length === 0 ? (
              <div className="empty-state">No tickers in this view.</div>
            ) : (
              items.map((item) => (
                <button
                  key={item.ticker}
                  type="button"
                  className="list-row"
                  aria-selected={selectedTicker === item.ticker}
                  onClick={() => setSelectedTicker(item.ticker)}
                >
                  <span className={`status-dot ${item.hasThesis ? "status-dot-ok" : "status-dot-warn"}`} />
                  <span className="list-row-main">
                    <span className="list-row-title mono">{item.ticker}</span>
                    <span className="list-row-sub">
                      {item.status === "covered"
                        ? "Thesis recorded"
                        : item.status === "empty_thesis"
                          ? "Template only (no thesis)"
                          : "No brain file yet"}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="split-detail">
          {error && <div className="banner banner-err">{error}</div>}
          {notice && <div className="banner banner-ok">{notice}</div>}

          {!selectedTicker ? (
            <div className="empty-state">Select a ticker to inspect or write its owner thesis.</div>
          ) : loadingDetail ? (
            <div className="empty-state">Loading {selectedTicker} brain file…</div>
          ) : detail ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h3 style={{ fontSize: 18, fontWeight: 600 }} className="mono">
                  {detail.ticker}
                </h3>
                <span className={`pill ${detail.hasThesis ? "pill-ok" : "pill-warn"}`}>
                  {detail.hasThesis ? "Thesis covered" : detail.status}
                </span>
                <span className="muted mono" style={{ fontSize: 11 }}>
                  {detail.filePath}
                </span>
                <span className="spacer" />
                {!editing && (
                  <div className="actions-row">
                    <button type="button" className="button button-primary" onClick={() => startEditing("thesis")}>
                      <Edit3 /> {detail.hasThesis ? "Edit Thesis Section" : "Write Thesis"}
                    </button>
                    {detail.content && (
                      <button type="button" className="button" onClick={() => startEditing("raw")}>
                        Edit Full Markdown
                      </button>
                    )}
                  </div>
                )}
              </div>

              {editing ? (
                <form className="subcard" onSubmit={saveThesis}>
                  <div className="subcard-head">
                    <span>
                      {editMode === "raw"
                        ? `Edit full markdown — ${detail.ticker}.md`
                        : `Update "## Your thesis" section — ${detail.ticker} (preserves surrounding history)`}
                    </span>
                  </div>
                  <div className="subcard-body form">
                    <textarea
                      className="control"
                      rows={12}
                      required
                      placeholder={
                        editMode === "raw"
                          ? "# TICKER\n\n## Your thesis (compiled truth)\n\n> ..."
                          : "State your plain-English owner thesis, moat durability, valuation anchor, and thesis-break criteria…"
                      }
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                    />
                    <div className="actions-row" style={{ justifyContent: "flex-end" }}>
                      <button type="button" className="button" onClick={() => setEditing(false)}>
                        Cancel
                      </button>
                      <button type="submit" className="button button-primary" disabled={saving}>
                        <Check /> {saving ? "Saving…" : "Save Verified to <brain>"}
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <>
                  {detail.extractedThesis && (
                    <div className="subcard">
                      <div className="subcard-head">
                        <BookOpen /> Recorded Owner Thesis
                      </div>
                      <div className="subcard-body">
                        <Markdown text={detail.extractedThesis} />
                      </div>
                    </div>
                  )}

                  {!detail.hasThesis && detail.researchAreas?.length > 0 && (
                    <div className="subcard">
                      <div className="subcard-head">
                        <span>Buffett 5-Pillar Research Agenda for {detail.ticker}</span>
                      </div>
                      <div className="subcard-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {detail.researchAreas.map((area, i) => (
                          <div key={area.area} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <strong style={{ fontSize: 13 }}>
                              {i + 1}. {area.title}
                            </strong>
                            <span className="muted" style={{ fontSize: 12 }}>
                              {area.whatBuffettWouldDo}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {detail.content && (
                    <div className="subcard">
                      <div className="subcard-head">Full Company Brain Note ({detail.ticker}.md)</div>
                      <div className="subcard-body">
                        <Markdown text={detail.content} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
