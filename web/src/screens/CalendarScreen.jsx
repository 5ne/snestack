import { useCallback, useEffect, useState } from "react";
import { Calendar as CalendarIcon, Play, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import Markdown from "../Markdown.jsx";
import ScreenHead from "../ui/ScreenHead.jsx";

export default function CalendarScreen() {
  const [status, setStatus] = useState(null);
  const [scope, setScope] = useState("today");
  const [customDate, setCustomDate] = useState("");
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [runningAgenda, setRunningAgenda] = useState(false);
  const [agendaOutput, setAgendaOutput] = useState("");
  const [error, setError] = useState("");

  const activeScope = scope === "date" && customDate ? customDate : scope === "date" ? "today" : scope;

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const st = await api("GET", "/api/domains/calendar/status");
      setStatus(st);
      if (st.authorized) {
        const ev = await api("GET", "/api/domains/calendar/events", { query: { scope: activeScope } });
        setEvents(Array.isArray(ev.events) ? ev.events : []);
      } else {
        setEvents([]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [activeScope]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  const runDailyAgenda = async () => {
    setRunningAgenda(true);
    setError("");
    try {
      const res = await api("POST", "/api/domains/calendar/skills/daily-agenda/run", {
        body: { subject: activeScope },
      });
      setAgendaOutput(res.result?.output || "");
    } catch (e) {
      setError(e.message);
    } finally {
      setRunningAgenda(false);
    }
  };

  return (
    <div className="screen">
      <ScreenHead
        title="Calendar"
        tools={
          <div className="seg" role="group" aria-label="Calendar scope">
            <button type="button" aria-pressed={scope === "today"} onClick={() => setScope("today")}>
              Today
            </button>
            <button type="button" aria-pressed={scope === "upcoming"} onClick={() => setScope("upcoming")}>
              Upcoming (7d)
            </button>
            <button type="button" aria-pressed={scope === "date"} onClick={() => setScope("date")}>
              Pick Date
            </button>
          </div>
        }
        note="Read-only Google Calendar integration"
      >
        <div className="actions-row">
          {scope === "date" && (
            <input
              type="date"
              className="control control-sm"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
            />
          )}
          <button type="button" className="button" onClick={loadCalendar} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} /> Refresh
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!status?.authorized || runningAgenda}
            onClick={runDailyAgenda}
          >
            <Play /> {runningAgenda ? "Synthesizing…" : "Run daily-agenda Skill"}
          </button>
        </div>
      </ScreenHead>

      <div className="screen-body">
        <div className="screen-pad">
          {error && <div className="banner banner-err">{error}</div>}

          {status && !status.authorized && (
            <div className="banner banner-warn">
              <div>
                <strong>Google Calendar OAuth is not yet authorized.</strong>
                <div style={{ marginTop: 4 }}>
                  Run <code>snestack calendar auth</code> once on your machine after setting{" "}
                  <code>SNESTACK_GOOGLE_CLIENT_ID</code> and <code>SNESTACK_GOOGLE_CLIENT_SECRET</code> in{" "}
                  <code>node/.env</code>.
                </div>
              </div>
            </div>
          )}

          {agendaOutput && (
            <div className="subcard">
              <div className="subcard-head">
                <CalendarIcon /> Daily Agenda Brief ({activeScope})
              </div>
              <div className="subcard-body">
                <Markdown text={agendaOutput} />
              </div>
            </div>
          )}

          {loading ? (
            <div className="empty-state">Loading calendar events…</div>
          ) : !status?.authorized ? null : events.length === 0 ? (
            <div className="empty-state">No events scheduled for {activeScope}.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Start</th>
                    <th>End</th>
                    <th>Summary</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev, i) => (
                    <tr key={ev.id || i}>
                      <td className="mono">{ev.start || "—"}</td>
                      <td className="mono">{ev.end || "—"}</td>
                      <td>
                        <strong>{ev.summary || "(Untitled event)"}</strong>
                      </td>
                      <td className="muted">{ev.location || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
