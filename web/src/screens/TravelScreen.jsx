import { useCallback, useEffect, useState } from "react";
import { Compass, FileText, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import Markdown from "../Markdown.jsx";
import ScreenHead from "../ui/ScreenHead.jsx";

export default function TravelScreen() {
  const [status, setStatus] = useState(null);
  const [years, setYears] = useState([]);
  const [selectedYear, setSelectedYear] = useState("");
  const [yearDetail, setYearDetail] = useState(null);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadYears = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [st, yrs] = await Promise.all([
        api("GET", "/api/domains/travel/status"),
        api("GET", "/api/domains/travel/years"),
      ]);
      setStatus(st);
      const list = yrs.years || [];
      setYears(list);
      if (list.length > 0 && !selectedYear) {
        setSelectedYear(String(list[0].year));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [selectedYear]);

  useEffect(() => {
    loadYears();
  }, [loadYears]);

  useEffect(() => {
    if (!selectedYear) return;
    let cancelled = false;
    api("GET", `/api/domains/travel/years/${encodeURIComponent(selectedYear)}`)
      .then((res) => {
        if (cancelled) return;
        setYearDetail(res);
        const files = res.files || [];
        const preferred = files.find((f) => f.startsWith("00-index")) || files[0] || "";
        setSelectedFile(preferred);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedYear]);

  useEffect(() => {
    if (!selectedYear || !selectedFile) {
      setFileContent("");
      return;
    }
    let cancelled = false;
    api(
      "GET",
      `/api/domains/travel/years/${encodeURIComponent(selectedYear)}/files/${encodeURIComponent(selectedFile)}`
    )
      .then((res) => {
        if (!cancelled) setFileContent(res.content || "");
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedYear, selectedFile]);

  return (
    <div className="screen">
      <ScreenHead
        title="Travel Brain"
        tools={
          years.length > 0 && (
            <div className="seg" role="tablist" aria-label="Cataloged years">
              {years.map((y) => (
                <button
                  key={y.year}
                  type="button"
                  aria-pressed={String(y.year) === String(selectedYear)}
                  onClick={() => setSelectedYear(String(y.year))}
                >
                  {y.year} ({y.tripCount})
                </button>
              ))}
            </div>
          )
        }
        note={
          status
            ? `Gmail: ${status.gmailAuthorized ? "authorized" : "not set"} · Timeline: ${
                status.timelineExists ? "present" : "missing"
              }${status.nextBackfillYear ? ` · next backfill: ${status.nextBackfillYear}` : ""}`
            : ""
        }
      >
        <button type="button" className="button" onClick={loadYears} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} /> Refresh
        </button>
      </ScreenHead>

      {years.length === 0 && !loading ? (
        <div className="screen-body">
          <div className="empty-state">
            <Compass />
            <p>No cataloged travel years found in &lt;brain&gt;/travel/.</p>
          </div>
        </div>
      ) : (
        <div className="split-pane">
          <aside className="split-list">
            <div className="split-list-items">
              <div className="nav-heading" style={{ margin: "6px 8px 4px" }}>
                {selectedYear} Files ({yearDetail?.files?.length ?? 0})
              </div>
              {(yearDetail?.files || []).map((f) => (
                <button
                  key={f}
                  type="button"
                  className="list-row"
                  aria-selected={selectedFile === f}
                  onClick={() => setSelectedFile(f)}
                >
                  <FileText style={{ width: 14, height: 14, opacity: 0.7 }} />
                  <span className="list-row-main">
                    <span className="list-row-title">{f.replace(/\.md$/, "")}</span>
                    <span className="list-row-sub">{f.startsWith("00-index") ? "Year index" : "Trip journal"}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="split-detail">
            {error && <div className="banner banner-err">{error}</div>}
            {!selectedFile ? (
              <div className="empty-state">Select a trip markdown file on the left.</div>
            ) : (
              <div className="subcard">
                <div className="subcard-head">
                  <span className="mono">
                    travel/{selectedYear}/{selectedFile}
                  </span>
                </div>
                <div className="subcard-body">
                  <Markdown text={fileContent} />
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
