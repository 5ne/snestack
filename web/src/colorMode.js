// Color mode: "light", "dark" or "auto" (follow the OS). Stored per browser and
// applied as <html data-theme>, which theme.css maps to color-scheme (Unison pattern).
const KEY = "snestack.theme";
export const MODES = ["light", "dark", "auto"];

export function getMode() {
  try {
    const mode = localStorage.getItem(KEY);
    return MODES.includes(mode) ? mode : "auto";
  } catch {
    return "auto";
  }
}

export function applyMode(mode) {
  const next = MODES.includes(mode) ? mode : "auto";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // ignore private browsing quota errors
  }
}
