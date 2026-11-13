import * as fs from "fs";
import * as path from "path";
import { parseVerdict } from "../../../core/verdict";
import type { Db } from "../../../core/db";
import { buffettResearchBrief, inspectTickerThesis } from "../thesisCoverage";

export const NO_THESIS_TAG = "[no thesis on file]";

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
const KNOWN_PREFIXES = ["[Long-term]", "[Swing]", "[Buffett]"];

/**
 * Drops any signal whose recommendation matches the last one recorded in `signals` for
 * the same ticker and strategy, AND whose confidence hasn't moved by at least
 * `confidenceMoveThreshold` — a ticker sitting at the same RSI extreme for hours (or an
 * unchanged long-term thesis) otherwise re-emails the identical verdict on every run, but
 * a same-label conviction swing (e.g. SELL 55% -> SELL 80%) is still worth surfacing. A
 * signal with no recognized strategy prefix, or no prior recorded signal, always passes
 * through unchanged (fails open, same philosophy as core/gate.ts).
 */
export async function filterUnchangedSignals(
  db: Db,
  signals: BuiltSignal[],
  confidenceMoveThreshold = 0.1
): Promise<{ changed: BuiltSignal[]; unchanged: BuiltSignal[] }> {
  const changed: BuiltSignal[] = [];
  const unchanged: BuiltSignal[] = [];
  for (const s of signals) {
    const prefix = KNOWN_PREFIXES.find((p) => s.reasoning.startsWith(p));
    const last = prefix ? await db.getLastSignalWithPrefix(s.ticker, prefix) : undefined;
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
  "buffett-value": "[Buffett]",
};
const FILE_RE = /^([A-Za-z0-9.\-]+?)-(long-term-quality|swing-trading-large-cap|buffett-value)\.md$/;

export interface EvaluatedVerdict {
  ticker: string;
  skill: string;
  verdict: string;
  rsi: number | null;
  price: number | null;
}

/** Tickers flagged isWatchlist in <dir>/data-dump.json (tolerates log lines before the JSON array). */
function readDumpEntries(dir: string): Array<{ ticker: string; isWatchlist?: boolean; quote?: { close?: number; rsi?: number | null } }> {
  const file = path.join(dir, "data-dump.json");
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const start = lines.findIndex((l) => l === "[");
    return JSON.parse(lines.slice(start < 0 ? 0 : start).join("\n"));
  } catch {
    return [];
  }
}

export function readWatchlistTickers(dir: string): Set<string> {
  const watch = new Set<string>();
  for (const e of readDumpEntries(dir)) {
    if (e.isWatchlist) watch.add(e.ticker);
  }
  return watch;
}

/**
 * Collect every valid verdict in <dir> (including NONE) with the ticker's RSI
 * and price from data-dump.json so the gate can track the last evaluated run
 * even when no BUY/SELL/HOLD signal was emitted.
 */
export function collectEvaluationsFromDir(dir: string): EvaluatedVerdict[] {
  const dumpByTicker = new Map<string, { rsi: number | null; price: number | null }>();
  for (const e of readDumpEntries(dir)) {
    dumpByTicker.set(e.ticker.toUpperCase(), {
      rsi: e.quote?.rsi ?? null,
      price: e.quote?.close ?? null,
    });
  }
  const evaluations: EvaluatedVerdict[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const [, rawTicker, skill] = m;
    const ticker = rawTicker.toUpperCase();
    const verdict = parseVerdict(fs.readFileSync(path.join(dir, name), "utf8"));
    if (!verdict) continue;
    if (!["BUY", "SELL", "HOLD", "NONE"].includes(verdict.label)) continue;
    const quote = dumpByTicker.get(ticker);
    evaluations.push({
      ticker,
      skill,
      verdict: verdict.label,
      rsi: quote?.rsi ?? null,
      price: quote?.price ?? null,
    });
  }
  return evaluations;
}

/**
 * Turn a run directory's skill write-ups into the signals array `notify` sends,
 * reading each file's trailing VERDICT line. Purely mechanical — the judgment
 * was already made by the skill — so it costs no model call and gives the same
 * answer every time.
 */
export function buildSignalsFromDir(dir: string, opts?: { brainRoot?: string }): BuildResult {
  const watchlist = readWatchlistTickers(dir);
  const checkBrain = Boolean(opts?.brainRoot && fs.existsSync(opts.brainRoot));
  const result: BuildResult = { signals: [], noSignal: [], errors: [] };

  for (const name of fs.readdirSync(dir).sort()) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const [, ticker, skill] = m;
    const upperTicker = ticker.toUpperCase();
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
    const missingThesis =
      checkBrain &&
      (skill === "long-term-quality" || skill === "buffett-value") &&
      !inspectTickerThesis(opts!.brainRoot!, upperTicker).hasThesis;
    const reasoning = missingThesis
      ? `${SKILL_PREFIX[skill]} ${NO_THESIS_TAG} ${verdict.reasoning} — Buffett research needed: ${buffettResearchBrief(upperTicker)}.`
      : `${SKILL_PREFIX[skill]} ${verdict.reasoning}`;

    result.signals.push({
      ticker: upperTicker,
      recommendation: verdict.label,
      confidence: verdict.confidence,
      reasoning,
      fromWatchlist: watchlist.has(upperTicker),
    });
  }
  return result;
}
