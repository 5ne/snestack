import * as fs from "fs";
import * as path from "path";
import { dayString, readSummary } from "./runCheck";
import { readRunEvents, type RunEvent } from "./runLog";

/**
 * Read-only cost / redundancy rollup over the run logs automations leave behind
 * (`run.json` + `run.jsonl`, see core/runLog.ts). Answers, per script and per
 * domain over 7 and 30 days: how much did it cost, how many model calls, how
 * often did the gate skip a call, and how often did a model call just repeat the
 * previous verdict for the same subject.
 *
 * Domain-agnostic on purpose: callers pass in `{ domain, script, runsRoot }`
 * targets (a domain's contextTools / run expectations decide what exists), and
 * this module only reads `run.json` and `run.jsonl`'s `gate` and `verdict`
 * events. Never writes anything.
 */

export const STATS_WINDOW_DAYS = [7, 30] as const;

/** A verdict counts as "the same" as the previous one when label and confidence band match. */
export const CONFIDENCE_BAND_WIDTH = 0.1;

export interface RunStatsTarget {
  domain: string;
  /** Script / automation name shown in the rollup, e.g. "financial-swing-check". */
  script: string;
  /** Same layout `run-check` reads: <runsRoot>/<YYYY-MM-DD>/run.json or <runsRoot>/<YYYY-MM-DD>/<HHMMSS>/run.json. */
  runsRoot: string;
}

export interface WindowStats {
  days: number;
  runs: number;
  model_calls: number;
  /** Sum of runs' est_cost_usd; runs with an unknown (null) cost are counted in `unknown_cost_runs`, not summed. */
  cost_usd: number;
  unknown_cost_runs: number;
  gate_evaluations: number;
  gate_skips: number;
  /** gate_skips / gate_evaluations, or null with no gate evaluations. */
  gate_skip_ratio: number | null;
  /** Verdicts that had a prior verdict for the same skill+subject to compare with. */
  verdict_comparable: number;
  /** Of those, how many matched the prior one's label and confidence band. */
  verdict_redundant: number;
  /** verdict_redundant / verdict_comparable, or null when nothing was comparable. */
  redundancy_ratio: number | null;
}

export interface ScriptStats {
  domain: string;
  script: string;
  windows: WindowStats[];
}

export interface DomainStats {
  domain: string;
  windows: WindowStats[];
}

export interface RunStatsResult {
  scripts: ScriptStats[];
  domains: DomainStats[];
}

interface LoadedRun {
  /** YYYY-MM-DD of the run's day directory. */
  date: string;
  sortKey: string;
  dryRun: boolean;
  cost: number | null;
  modelCalls: number;
  events: RunEvent[];
}

/** Every completed (run.json present) non-dry run under root, within `days` back, oldest first. */
function loadRuns(root: string, now: Date, days: number): LoadedRun[] {
  if (!fs.existsSync(root)) return [];
  const cutoff = dayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
  const runs: LoadedRun[] = [];

  const load = (dir: string, date: string, sub: string) => {
    const summary = readSummary(dir);
    if (!summary) return; // incomplete runs are run-check's business, not a cost number
    runs.push({
      date,
      sortKey: `${date} ${sub}`,
      dryRun: summary.dry_run,
      cost: summary.model_calls.est_cost_usd,
      modelCalls: summary.model_calls.count,
      events: readRunEvents(dir),
    });
  };

  for (const name of fs.readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name < cutoff) continue;
    const dayDir = path.join(root, name);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    if (fs.existsSync(path.join(dayDir, "run.json"))) {
      load(dayDir, name, "");
      continue;
    }
    for (const sub of fs.readdirSync(dayDir).sort()) {
      const subDir = path.join(dayDir, sub);
      if (fs.statSync(subDir).isDirectory()) load(subDir, name, sub);
    }
  }
  return runs.filter((r) => !r.dryRun).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

export function confidenceBand(confidence: number): number {
  return Math.floor(confidence / CONFIDENCE_BAND_WIDTH + 1e-9);
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export function emptyWindow(days: number): WindowStats {
  return {
    days,
    runs: 0,
    model_calls: 0,
    cost_usd: 0,
    unknown_cost_runs: 0,
    gate_evaluations: 0,
    gate_skips: 0,
    gate_skip_ratio: null,
    verdict_comparable: 0,
    verdict_redundant: 0,
    redundancy_ratio: null,
  };
}

function finishWindow(w: WindowStats): WindowStats {
  w.cost_usd = Math.round(w.cost_usd * 10000) / 10000;
  w.gate_skip_ratio = ratio(w.gate_skips, w.gate_evaluations);
  w.redundancy_ratio = ratio(w.verdict_redundant, w.verdict_comparable);
  return w;
}

/** Windows for one script's runs (sorted oldest first, covering the longest window). */
function statsForRuns(runs: LoadedRun[], now: Date, windows: readonly number[]): WindowStats[] {
  const windowStats = windows.map((d) => emptyWindow(d));
  const cutoffs = windows.map((d) => dayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (d - 1))));
  // Last verdict seen per skill+subject across the whole loaded history, so the
  // first call inside a window still compares against the call just before it.
  const lastVerdict = new Map<string, { label: string; band: number }>();

  for (const run of runs) {
    const inWindow = windowStats.filter((_, i) => run.date >= cutoffs[i]);
    for (const w of inWindow) {
      w.runs++;
      w.model_calls += run.modelCalls;
      if (run.cost == null) w.unknown_cost_runs++;
      else w.cost_usd += run.cost;
    }
    for (const e of run.events) {
      if (e.event === "gate") {
        for (const w of inWindow) {
          w.gate_evaluations++;
          if (e.run === false) w.gate_skips++;
        }
      } else if (e.event === "verdict" && typeof e.label === "string" && typeof e.confidence === "number") {
        const key = `${e.skill ?? ""}|${e.subject ?? ""}`;
        const current = { label: e.label, band: confidenceBand(e.confidence) };
        const prior = lastVerdict.get(key);
        if (prior) {
          const same = prior.label === current.label && prior.band === current.band;
          for (const w of inWindow) {
            w.verdict_comparable++;
            if (same) w.verdict_redundant++;
          }
        }
        lastVerdict.set(key, current);
      }
    }
  }
  return windowStats.map(finishWindow);
}

function addWindow(into: WindowStats, from: WindowStats): void {
  into.runs += from.runs;
  into.model_calls += from.model_calls;
  into.cost_usd += from.cost_usd;
  into.unknown_cost_runs += from.unknown_cost_runs;
  into.gate_evaluations += from.gate_evaluations;
  into.gate_skips += from.gate_skips;
  into.verdict_comparable += from.verdict_comparable;
  into.verdict_redundant += from.verdict_redundant;
}

export function computeRunStats(
  targets: RunStatsTarget[],
  now: Date,
  windows: readonly number[] = STATS_WINDOW_DAYS
): RunStatsResult {
  const longest = Math.max(...windows);
  const scripts: ScriptStats[] = targets.map((t) => ({
    domain: t.domain,
    script: t.script,
    windows: statsForRuns(loadRuns(t.runsRoot, now, longest), now, windows),
  }));

  const domains: DomainStats[] = [];
  for (const domain of [...new Set(scripts.map((s) => s.domain))]) {
    const totals = windows.map((d) => emptyWindow(d));
    for (const s of scripts.filter((x) => x.domain === domain)) {
      s.windows.forEach((w, i) => addWindow(totals[i], w));
    }
    domains.push({ domain, windows: totals.map(finishWindow) });
  }
  return { scripts, domains };
}

function pct(r: number | null): string {
  return r == null ? "n/a" : `${Math.round(r * 100)}%`;
}

function formatWindow(w: WindowStats): string {
  const cost = `$${w.cost_usd.toFixed(2)}${w.unknown_cost_runs ? ` (+${w.unknown_cost_runs} run(s) unknown cost)` : ""}`;
  const redundancy =
    w.verdict_comparable > 0 ? `${pct(w.redundancy_ratio)} (${w.verdict_redundant}/${w.verdict_comparable})` : "n/a (no comparable verdicts)";
  const gate = w.gate_evaluations > 0 ? `${pct(w.gate_skip_ratio)} (${w.gate_skips}/${w.gate_evaluations})` : "n/a (no gate evaluations)";
  return `${w.days}d: ${w.runs} runs, ${w.model_calls} model calls, ${cost}; gate skip ${gate}; redundant verdicts ${redundancy}`;
}

/** Plain-text rollup, one line per window, scripts grouped under their domain. */
export function formatRunStats(result: RunStatsResult): string {
  const lines: string[] = [];
  for (const d of result.domains) {
    lines.push(`${d.domain} (all scripts)`);
    d.windows.forEach((w) => lines.push(`  ${formatWindow(w)}`));
    for (const s of result.scripts.filter((x) => x.domain === d.domain)) {
      lines.push(`  ${s.script}`);
      s.windows.forEach((w) => lines.push(`    ${formatWindow(w)}`));
    }
  }
  return lines.join("\n");
}
