import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BookOpen,
  Briefcase,
  Calendar,
  Compass,
  KeyRound,
  Settings,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { api, getToken, setToken } from "./api.js";
import CalendarScreen from "./screens/CalendarScreen.jsx";
import PortfolioScreen from "./screens/PortfolioScreen.jsx";
import RunsScreen from "./screens/RunsScreen.jsx";
import SignalsScreen from "./screens/SignalsScreen.jsx";
import SkillsScreen from "./screens/SkillsScreen.jsx";
import SystemScreen from "./screens/SystemScreen.jsx";
import ThesesScreen from "./screens/ThesesScreen.jsx";
import TravelScreen from "./screens/TravelScreen.jsx";
import Dialog from "./ui/Dialog.jsx";
import ThemeSwitch from "./ui/ThemeSwitch.jsx";

const NAV_SECTIONS = [
  {
    heading: "Investing",
    items: [
      { id: "portfolio", label: "Portfolio", icon: Briefcase },
      { id: "signals", label: "Signals", icon: TrendingUp },
      { id: "theses", label: "Company Theses", icon: BookOpen },
    ],
  },
  {
    heading: "Harness",
    items: [
      { id: "skills", label: "Skills & Domains", icon: Sparkles },
      { id: "runs", label: "Runs & Health", icon: Activity },
    ],
  },
  {
    heading: "Life Domains",
    items: [
      { id: "calendar", label: "Calendar", icon: Calendar },
      { id: "travel", label: "Travel Brain", icon: Compass },
    ],
  },
  {
    heading: "Server",
    items: [{ id: "system", label: "System & API", icon: Settings }],
  },
];

const ALL_SCREENS = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id));

function parseScreenFromLocation() {
  const seg = window.location.pathname.replace(/^\/+/, "").split("/")[0];
  return ALL_SCREENS.includes(seg) ? seg : "portfolio";
}

export default function App() {
  const [screen, setScreen] = useState(parseScreenFromLocation);
  const [health, setHealth] = useState(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(getToken);
  const [authKey, setAuthKey] = useState(0);

  // Cross-screen navigation helpers
  const [thesisTarget, setThesisTarget] = useState("");
  const [skillPresetSubject, setSkillPresetSubject] = useState("");

  const navigate = useCallback((nextScreen) => {
    setScreen(nextScreen);
    const targetPath = nextScreen === "portfolio" ? "/" : `/${nextScreen}`;
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, "", targetPath);
    }
  }, []);

  useEffect(() => {
    const onPop = () => setScreen(parseScreenFromLocation());
    const onUnauth = () => {
      setTokenDraft(getToken());
      setAuthDialogOpen(true);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("snestack:unauthorized", onUnauth);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("snestack:unauthorized", onUnauth);
    };
  }, []);

  const refreshHealth = useCallback(() => {
    api("GET", "/api/health")
      .then((res) => {
        setHealth(res);
        if (res.authRequired && !getToken()) {
          setAuthDialogOpen(true);
        }
      })
      .catch(() => {
        setHealth(null);
      });
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth, authKey]);

  const openThesisForTicker = useCallback(
    (ticker) => {
      setThesisTarget(ticker);
      navigate("theses");
    },
    [navigate]
  );

  const openSkillForTicker = useCallback(
    (ticker) => {
      setSkillPresetSubject(ticker);
      navigate("skills");
    },
    [navigate]
  );

  const submitTokenGate = (e) => {
    e.preventDefault();
    setToken(tokenDraft);
    setAuthDialogOpen(false);
    setAuthKey((k) => k + 1);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="ws-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-title">snestack</span>
          <span className="brand-sub" title={health ? `v${health.version} (${health.domains?.join(", ")})` : "offline"}>
            <span className={`status-dot ${health?.status === "ok" ? "status-dot-ok" : "status-dot-warn"}`} />
            {health ? `v${health.version}` : "connecting"}
          </span>
        </div>

        <nav className="sidebar-content" aria-label="Main navigation">
          {NAV_SECTIONS.map((section) => (
            <div key={section.heading} className="sidebar-section">
              <div className="nav-heading">{section.heading}</div>
              <ul className="nav-list">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="nav-link"
                        aria-current={screen === item.id ? "page" : undefined}
                        onClick={() => navigate(item.id)}
                      >
                        <Icon aria-hidden="true" />
                        <span>{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-foot-row">
            <ThemeSwitch />
            {health?.authRequired && (
              <button
                type="button"
                className="button button-ghost button-icon"
                title="Configure API Bearer Token"
                aria-label="Configure API Bearer Token"
                onClick={() => {
                  setTokenDraft(getToken());
                  setAuthDialogOpen(true);
                }}
              >
                <KeyRound />
              </button>
            )}
          </div>
        </div>
      </aside>

      <main className="shell-main panel" key={authKey}>
        {screen === "portfolio" && (
          <PortfolioScreen
            onOpenThesis={openThesisForTicker}
            onOpenSkillForTicker={openSkillForTicker}
          />
        )}
        {screen === "signals" && <SignalsScreen onOpenThesis={openThesisForTicker} />}
        {screen === "theses" && <ThesesScreen initialTicker={thesisTarget} />}
        {screen === "skills" && (
          <SkillsScreen
            presetSubject={skillPresetSubject}
            onConsumePresetSubject={() => setSkillPresetSubject("")}
          />
        )}
        {screen === "runs" && <RunsScreen />}
        {screen === "calendar" && <CalendarScreen />}
        {screen === "travel" && <TravelScreen />}
        {screen === "system" && <SystemScreen onTokenSaved={() => setAuthKey((k) => k + 1)} />}
      </main>

      <nav className="tabbar" aria-label="Mobile navigation">
        {NAV_SECTIONS.flatMap((s) => s.items).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="tabbar-btn"
              aria-current={screen === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <Icon />
              <span>{item.label.split(" ")[0]}</span>
            </button>
          );
        })}
      </nav>

      <Dialog
        open={authDialogOpen}
        onClose={() => setAuthDialogOpen(false)}
        title="Enter snestack API Token"
      >
        <form className="form" onSubmit={submitTokenGate}>
          <p className="muted">
            This <code>snestack serve</code> instance requires <code>SNESTACK_API_TOKEN</code> Bearer authentication.
            Your token is stored locally in this browser.
          </p>
          <label className="field">
            <span className="field-label">Bearer Token</span>
            <input
              type="password"
              className="control mono"
              autoFocus
              required
              placeholder="Paste SNESTACK_API_TOKEN…"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
          </label>
          <div className="actions-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="button" onClick={() => setAuthDialogOpen(false)}>
              Dismiss
            </button>
            <button type="submit" className="button button-primary">
              Authenticate
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
