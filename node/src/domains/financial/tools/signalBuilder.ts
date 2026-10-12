import * as fs from "fs";
import * as path from "path";
import { parseVerdict } from "../../../core/verdict";
import type { Db } from "../../../core/db";

export interface BuiltSignal {
  ticker: string;
  recommendation: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reasoning: string;
  fromWatchlist: boolean;
}

export interface BuildResult {
  signals: BuiltSignal[];
  /** Files whose skill concluded there is nothing to report (VERDICT: NONE). */
  noSignal: string[];
  /** Files with a missing or invalid VERDICT line — each is a real problem to surface. */
  errors: string[];
}

/** The strategy prefixes buildSignalsFromDir bakes into `reasoning` (see SKILL_PREFIX below). */
const KNOWN_PREFIXES = ["[Long-term]", "[Swing]"];

/**
 * Drops any signal whose recommendation matches the last one recorded in `signals` for
 * the same ticker and strategy, AND whose confidence hasn't moved by at least
 * `confidenceMoveThreshold` — a ticker sitting at the same RSI extreme for hours (or an
 * unchanged long-term thesis) otherwise re-emails the identical verdict on every run, but
 * a same-label conviction swing (e.g. SELL 55% -> SELL 80%) is still worth surfacing. A
 * signal with no recognized strategy prefix, or no prior recorded signal, always passes
 * through unchanged (fails open, same philosophy as core/gate.ts).
 */
export function filterUnchangedSignals(
  db: Db,
  signals: BuiltSignal[],
  confidenceMoveThreshold = 0.1
): { changed: BuiltSignal[]; unchanged: BuiltSignal[] } {
  const changed: BuiltSignal[] = [];
  const unchanged: BuiltSignal[] = [];
  for (const s of signals) {
    const prefix = KNOWN_PREFIXES.find((p) => s.reasoning.startsWith(p));
    const last = prefix ? db.getLastSignalWithPrefix(s.ticker, prefix) : undefined;
    const sameLabel = last && last.recommendation === s.recommendation;
    const confidenceMoved = last != null && Math.abs(s.confidence - last.confidence) >= confidenceMoveThreshold;
    if (sameLabel && !confidenceMoved) {
      unchanged.push(s);
    } else {
      changed.push(s);
    }
  }
  return { changed, unchanged };
}

const SKILL_PREFIX: Record<string, string> = {
  "long-term-quality": "[Long-term]",
  "swing-trading-large-cap": "[Swing]",
};
const FILE_RE = /^([A-Za-z0-9.\-]+?)-(long-term-quality|swing-trading-large-cap)\.md$/;

/** Tickers flagged isWatchlist in <dir>/data-dump.json (tolerates log lines before the JSON array). */
export function readWatchlistTickers(dir: string): Set<string> {
  const watch = new Set<string>();
  const file = path.join(dir, "data-dump.json");
  if (!fs.existsSync(file)) return watch;
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const start = lines.findIndex((l) => l === "[");
    const arr = JSON.parse(lines.slice(start < 0 ? 0 : start).join("\n")) as Array<{ ticker: string; isWatchlist?: boolean }>;
    arr.forEach((e) => e.isWatchlist && watch.add(e.ticker));
  } catch {
    // an unreadable dump just means every ticker is treated as a position
  }
  return watch;
}

/**
 * Turn a run directory's skill write-ups into the signals array `notify` sends,
 * reading each file's trailing VERDICT line. Purely mechanical — the judgment
 * was already made by the skill — so it costs no model call and gives the same
 * answer every time.
 */
export function buildSignalsFromDir(dir: string): BuildResult {
  const watchlist = readWatchlistTickers(dir);
  const result: BuildResult = { signals: [], noSignal: [], errors: [] };

  for (const name of fs.readdirSync(dir).sort()) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const [, ticker, skill] = m;
    const verdict = parseVerdict(fs.readFileSync(path.join(dir, name), "utf8"));

    if (!verdict) {
      result.errors.push(`${name}: no valid "VERDICT: LABEL | confidence | reasoning" line`);
      continue;
    }
    if (verdict.label === "NONE") {
      result.noSignal.push(name);
      continue;
    }
    if (verdict.label !== "BUY" && verdict.label !== "SELL" && verdict.label !== "HOLD") {
      result.errors.push(`${name}: unknown verdict label "${verdict.label}" (expected BUY, SELL, HOLD or NONE)`);
      continue;
    }
    result.signals.push({
      ticker: ticker.toUpperCase(),
      recommendation: verdict.label,
      confidence: verdict.confidence,
      reasoning: `${SKILL_PREFIX[skill]} ${verdict.reasoning}`,
      fromWatchlist: watchlist.has(ticker.toUpperCase()),
    });
  }
  return result;
}
