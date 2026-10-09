import * as fs from "fs";
import * as path from "path";
import type { RunSummary } from "./runLog";

/**
 * Deterministic health check over the run summaries automations leave behind
 * (see core/runLog.ts). This is the half of "watch the automations" that needs
 * no judgment: was a run expected, did it happen, did it finish, did anything
 * fail or get truncated, did cost jump. A Claude watcher agent reads the
 * findings and does the investigating; this just makes the facts cheap to get.
 */

export interface RunExpectation {
  /** Domain/automation name shown in findings, e.g. "financial". */
  name: string;
  /**
   * Directory holding one YYYY-MM-DD subdirectory per run day. In single-run
   * mode (minRunsPerDay unset) that day directory IS the run (run.json lives
   * directly in it). In multi-run mode, the day directory instead holds one
   * timestamped subdirectory per run that day (e.g. HHMMSS/run.json) — for
   * automations like intraday refresh or swing-check that fire several times
   * a day rather than once.
   */
  runsRoot: string;
  /** Whether a run should exist for this local day. */
  expectedOn: (day: Date) => boolean;
  /** A run for today isn't expected until the local clock passes this hour. */
  graceHour: number;
  /** Don't expect runs before this date (YYYY-MM-DD) — e.g. before run logging existed. */
  since?: string;
  /**
   * For automations that run multiple times a day: the minimum number of
   * completed runs expected for the day once graceHour has passed. Switches
   * runsRoot/<date> from "is a run" to "holds runs" (see runsRoot above).
   * Cost-anomaly comparison is skipped in this mode — a single day's typical
   * per-run cost isn't a stable enough baseline across a handful of runs.
   */
  minRunsPerDay?: number;
}

export type Severity = "error" | "warn";

export interface Finding {
  severity: Severity;
  domain: string;
  date: string;
  code: "missing_run" | "incomplete_run" | "failed" | "degraded" | "model_errors" | "cost_anomaly" | "cache_stale";
  message: string;
}

export function dayString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function readSummary(dir: string): RunSummary | null {
  const file = path.join(dir, "run.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RunSummary;
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Real (non-dry-run) summaries in a runs root, keyed by day, for cost comparison. */
function historicalCosts(runsRoot: string): Map<string, number> {
  const costs = new Map<string, number>();
  if (!fs.existsSync(runsRoot)) return costs;
  for (const name of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const s = readSummary(path.join(runsRoot, name));
    if (s && !s.dry_run && s.model_calls.est_cost_usd != null && s.model_calls.est_cost_usd > 0) {
      costs.set(name, s.model_calls.est_cost_usd);
    }
  }
  return costs;
}

/** Findings that only need one run's own summary — failed/degraded/errored/cost-anomalous. */
function findingsForSummary(
  exp: RunExpectation,
  date: string,
  summary: RunSummary,
  costs: Map<string, number>,
  labelSuffix: string
): Finding[] {
  const findings: Finding[] = [];

  if (summary.status === "failed") {
    const detail = summary.failed_steps
      .slice(0, 5)
      .map((f) => `${f.step}${f.subject ? ` ${f.subject}` : ""}${f.error ? ` — ${f.error.slice(0, 120)}` : ""}`)
      .join("; ");
    findings.push({
      severity: "error",
      domain: exp.name,
      date,
      code: "failed",
      message: `${labelSuffix}${summary.steps.failed} step(s) failed${detail ? `: ${detail}` : ""}${
        summary.failed_steps.length > 5 ? " …" : ""
      }`,
    });
  }
  if (summary.status === "degraded" || summary.truncated_steps.length || summary.model_calls.truncated) {
    findings.push({
      severity: "warn",
      domain: exp.name,
      date,
      code: "degraded",
      message: `${labelSuffix}${summary.model_calls.truncated} model call(s) hit max_tokens and were cut off${
        summary.truncated_steps.length
          ? ` (${summary.truncated_steps.map((t) => `${t.step}${t.subject ? ` ${t.subject}` : ""}`).join(", ")})`
          : ""
      }.`,
    });
  }
  if (summary.model_calls.errors > 0) {
    findings.push({
      severity: "warn",
      domain: exp.name,
      date,
      code: "model_errors",
      message: `${labelSuffix}${summary.model_calls.errors} model call(s) errored.`,
    });
  }

  const cost = summary.model_calls.est_cost_usd;
  if (cost != null && !summary.dry_run && !exp.minRunsPerDay) {
    const prior = [...costs.entries()].filter(([d]) => d < date).map(([, c]) => c);
    if (prior.length >= 3) {
      const typical = median(prior);
      if (cost > typical * 2) {
        findings.push({
          severity: "warn",
          domain: exp.name,
          date,
          code: "cost_anomaly",
          message: `${labelSuffix}Estimated cost $${cost.toFixed(2)} is more than 2x the typical $${typical.toFixed(
            2
          )} (median of ${prior.length} earlier runs).`,
        });
      }
    }
  }
  return findings;
}

export function evaluateRuns(opts: { now: Date; days: number; expectations: RunExpectation[] }): Finding[] {
  const findings: Finding[] = [];
  const { now, days } = opts;
  const today = dayString(now);

  for (const exp of opts.expectations) {
    const costs = exp.minRunsPerDay ? new Map<string, number>() : historicalCosts(exp.runsRoot);

    for (let offset = 0; offset < days; offset++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      const date = dayString(day);
      if (exp.since && date < exp.since) continue;
      if (!exp.expectedOn(day)) continue;
      if (date === today && now.getHours() < exp.graceHour) continue;

      const dayDir = path.join(exp.runsRoot, date);

      if (exp.minRunsPerDay) {
        const runDirs = fs.existsSync(dayDir)
          ? fs
              .readdirSync(dayDir)
              .filter((name) => fs.existsSync(path.join(dayDir, name, "run.json")))
              .sort()
          : [];

        if (runDirs.length === 0) {
          findings.push({
            severity: "error",
            domain: exp.name,
            date,
            code: "missing_run",
            message: `No runs recorded for a day at least ${exp.minRunsPerDay} were expected (cron didn't fire, the machine was asleep, or every run died before logging).`,
          });
          continue;
        }
        if (runDirs.length < exp.minRunsPerDay) {
          findings.push({
            severity: "warn",
            domain: exp.name,
            date,
            code: "missing_run",
            message: `Only ${runDirs.length} of the ${exp.minRunsPerDay}+ expected runs were recorded today.`,
          });
        }
        for (const runDir of runDirs) {
          const summary = readSummary(path.join(dayDir, runDir));
          if (!summary) continue; // filtered on run.json existing above, but keep the null check honest
          findings.push(...findingsForSummary(exp, date, summary, costs, `[${runDir}] `));
        }
        continue;
      }

      const summary = readSummary(dayDir);
      const started = fs.existsSync(path.join(dayDir, "run.jsonl"));

      if (!summary) {
        findings.push(
          started
            ? {
                severity: "error",
                domain: exp.name,
                date,
                code: "incomplete_run",
                message: "run.jsonl exists but run.json was never written — the run crashed or was killed before finishing.",
              }
            : {
                severity: "error",
                domain: exp.name,
                date,
                code: "missing_run",
                message: "No run recorded for a day one was expected (cron didn't fire, the machine was asleep, or the script died before logging).",
              }
        );
        continue;
      }

      findings.push(...findingsForSummary(exp, date, summary, costs, ""));
    }
  }
  return findings;
}

/**
 * Checks whether any tracked ticker's latest cached fundamentals/quote row is
 * older than its tier's safety-net max-age (see domains/financial/contextTools.ts,
 * Phase 4 of the pipeline migration). Unlike evaluateRuns, this isn't about
 * whether a refresh ran — it's about whether the refreshes that did run
 * actually landed fresh data (e.g. Finnhub was down for the whole window).
 */
export function checkCacheStaleness(opts: {
  now: Date;
  tickers: string[];
  getLatestQuoteAge: (ticker: string) => number | null;
  getLatestFundamentalsAge: (ticker: string, source: "finnhub" | "morningstar") => number | null;
}): Finding[] {
  const findings: Finding[] = [];
  const date = dayString(opts.now);
  const QUOTE_STALE_MS = 48 * 60 * 60 * 1000;
  const FINNHUB_STALE_MS = 48 * 60 * 60 * 1000;
  const MORNINGSTAR_STALE_MS = 21 * 24 * 60 * 60 * 1000;

  const staleTickers = (ageMs: (ticker: string) => number | null, thresholdMs: number): string[] =>
    opts.tickers.filter((t) => {
      const age = ageMs(t);
      return age == null || age > thresholdMs;
    });

  const report = (label: string, thresholdHours: string, tickers: string[]) => {
    if (tickers.length === 0) return;
    findings.push({
      severity: "warn",
      domain: "financial",
      date,
      code: "cache_stale",
      message: `${label} stale (>${thresholdHours}) or missing for: ${tickers.join(", ")} — is data-refresh running?`,
    });
  };

  report("quotes", "48h", staleTickers((t) => opts.getLatestQuoteAge(t), QUOTE_STALE_MS));
  report(
    "finnhub fundamentals",
    "48h",
    staleTickers((t) => opts.getLatestFundamentalsAge(t, "finnhub"), FINNHUB_STALE_MS)
  );
  report(
    "morningstar fundamentals",
    "21d",
    staleTickers((t) => opts.getLatestFundamentalsAge(t, "morningstar"), MORNINGSTAR_STALE_MS)
  );

  return findings;
}
