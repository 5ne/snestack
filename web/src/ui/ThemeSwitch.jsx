import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyMode, getMode, MODES } from "../colorMode.js";

const ICONS = { light: Sun, dark: Moon, auto: Monitor };
const LABELS = { light: "Light", dark: "Dark", auto: "Auto" };

export default function ThemeSwitch() {
  const [mode, setMode] = useState(getMode);
  const choose = (m) => {
    applyMode(m);
    setMode(m);
  };
  return (
    <div className="seg" role="group" aria-label="Theme">
      {MODES.map((m) => {
        const Icon = ICONS[m];
        return (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            aria-label={LABELS[m]}
            title={`Theme: ${LABELS[m]}`}
            onClick={() => choose(m)}
          >
            <Icon aria-hidden="true" />
            <span>{LABELS[m]}</span>
          </button>
        );
      })}
    </div>
  );
}
