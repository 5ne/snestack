import * as fs from "fs";
import * as path from "path";
import { evaluateRuns, checkCacheStaleness, readSummary, type RunExpectation, type Finding } from "./runCheck";
import { listProposals, featureRequestsDir } from "./featureRequests";

/**
 * Builds the digest an `improve-self` skill reads: recent automation health,
 * recent run summaries, and every existing feature-request proposal (so the
 * skill doesn't duplicate one, and so a still-live issue is a signal the
 * existing proposal needs attention rather than a reason to write a new one).
 *
 * Domain-agnostic — each domain's own wiring (its contextTools module)
 * decides which run roots and RunExpectations to pass in, same pattern as
 * `domains/financial/gate.ts`'s `computeGateFacts`. A domain with nothing
 * wired up yet (calendar, travel) just gets an empty digest from that
 * source, not an error.
 */

export interface ReflectOpts {
  domain: string;
  brainRoot: string;
  now: Date;
  /** Lookback window in days for run-health and run-summary sources. */
  days: number;
}

export interface DigestSource {
  name: string;
  /** Pre-formatted text block, or empty/whitespace-only if there's nothing to report. */
  fetch(opts: ReflectOpts): string;
}

/** Concatenates every source's non-empty output into one digest string the skill's prompt can read. */
export function gatherReflectionDigest(sources: DigestSource[], opts: ReflectOpts): string {
  const blocks: string[] = [];
  for (const source of sources) {
    const text = source.fetch(opts).trim();
    if (text) blocks.push(`### ${source.name}\n\n${text}`);
  }
  return blocks.length ? blocks.join("\n\n") : "(nothing to report from any source — all quiet.)";
}

function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `- [${f.severity}] ${f.date} ${f.domain} ${f.code}: ${f.message}`).join("\n");
}

/**
 * `run-check` findings (missing/failed/degraded runs, cost anomalies, stale
 * caches) for a domain with `RunExpectation`s of its own. Pass `[]` for
 * `expectations` (and omit `staleness`) for a domain with no scheduled jobs
 * yet — the source then always reports nothing, which is expected, not a bug.
 */
export function runCheckFindingsSource(
  expectations: RunExpectation[],
  staleness?: {
    tickers: string[];
    getLatestQuoteAge: (ticker: string) => number | null;
    getLatestFundamentalsAge: (ticker: string, source: "finnhub" | "morningstar") => number | null;
  }
): DigestSource {
  return {
    name: "run-check-findings",
    fetch(opts) {
      const findings = evaluateRuns({ now: opts.now, days: opts.days, expectations });
      const staleFindings = staleness ? checkCacheStaleness({ now: opts.now, ...staleness }) : [];
      return formatFindings([...findings, ...staleFindings]);
    },
  };
}

interface RunJsonRef {
  label: string;
  file: string;
}

/** Every run.json under `root/<YYYY-MM-DD>/` (single-run) or `root/<YYYY-MM-DD>/<HHMMSS>/` (multi-run-a-day), within the lookback window. */
function collectRunJsonFiles(root: string, now: Date, days: number): RunJsonRef[] {
  if (!fs.existsSync(root)) return [];
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const refs: RunJsonRef[] = [];

  for (const name of fs.readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const day = new Date(`${name}T00:00:00`);
    if (day < cutoff) continue;
    const dayDir = path.join(root, name);

    const direct = path.join(dayDir, "run.json");
    if (fs.existsSync(direct)) {
      refs.push({ label: name, file: direct });
      continue;
    }
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const sub of fs.readdirSync(dayDir).sort()) {
      const f = path.join(dayDir, sub, "run.json");
      if (fs.existsSync(f)) refs.push({ label: `${name} ${sub}`, file: f });
    }
  }
  return refs.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** Recent run.json summaries (status, failures, errors, cost) across one or more run roots. */
export function runSummariesSource(runRoots: string[]): DigestSource {
  return {
    name: "run-summaries",
    fetch(opts) {
      const lines: string[] = [];
      for (const root of runRoots) {
        for (const { label, file } of collectRunJsonFiles(root, opts.now, opts.days)) {
          const summary = readSummary(path.dirname(file));
          if (!summary) continue;
          const parts = [`status=${summary.status}`];
          if (summary.steps.failed) parts.push(`failed_steps=${summary.steps.failed}`);
          if (summary.model_calls.errors) parts.push(`model_errors=${summary.model_calls.errors}`);
          if (summary.model_calls.truncated) parts.push(`truncated=${summary.model_calls.truncated}`);
          if (summary.model_calls.est_cost_usd != null) parts.push(`cost=$${summary.model_calls.est_cost_usd.toFixed(2)}`);
          lines.push(`- ${path.basename(root)} ${label}: ${parts.join(", ")}`);
        }
      }
      return lines.join("\n");
    },
  };
}

/** Every existing feature-request proposal for the domain, any status — the key dedup input. */
export function existingFeatureRequestsSource(): DigestSource {
  return {
    name: "existing-feature-requests",
    fetch(opts) {
      const proposals = listProposals(opts.brainRoot, opts.domain);
      return proposals.map((p) => `- [${p.status}] ${p.slug}: ${p.title} (impact=${p.impact ?? "?"}, effort=${p.effort ?? "?"})`).join("\n");
    },
  };
}

/**
 * `improve-self` has no per-ticker signal row to read a last-run timestamp
 * from (unlike the judgment skills — see `domains/financial/gate.ts`'s
 * `computeGateFacts`), so it gets its own tiny marker file instead, written by
 * `snestack reflect` after each actual run (see `core/featureRequests.ts`'s
 * safety line — this file lives next to the proposals it's about, not
 * anywhere near source/config).
 */
const LAST_RUN_FILE = ".last-run.json";

function lastRunFile(brainRoot: string, domain: string): string {
  return path.join(featureRequestsDir(brainRoot, domain), LAST_RUN_FILE);
}

/** When `improve-self` last actually ran for this domain, or null if never. */
export function readLastReflectRun(brainRoot: string, domain: string): Date | null {
  const file = lastRunFile(brainRoot, domain);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { lastRunAt?: string };
    if (!data.lastRunAt) return null;
    const d = new Date(data.lastRunAt);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Records that `improve-self` just ran for this domain — call this after every actual run, proposals or not. */
export function recordReflectRun(brainRoot: string, domain: string, now: Date): void {
  const dir = featureRequestsDir(brainRoot, domain);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lastRunFile(brainRoot, domain), JSON.stringify({ lastRunAt: now.toISOString() }) + "\n", "utf8");
}

/** Newest mtime of any run.json under a run root (single- or multi-run-per-day layout), or 0 if none. */
function newestRunJsonMtimeMs(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let newest = 0;
  for (const name of fs.readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const dayDir = path.join(root, name);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    const direct = path.join(dayDir, "run.json");
    if (fs.existsSync(direct)) {
      newest = Math.max(newest, fs.statSync(direct).mtimeMs);
      continue;
    }
    for (const sub of fs.readdirSync(dayDir)) {
      const f = path.join(dayDir, sub, "run.json");
      if (fs.existsSync(f)) newest = Math.max(newest, fs.statSync(f).mtimeMs);
    }
  }
  return newest;
}

/**
 * Whether any run.json across the given run roots is newer than `since` —
 * `improve-self`'s gate `inputsUpdated` trigger: nothing new to reflect on
 * means no reason to run early. `since == null` (no previous run on record)
 * is true unconditionally — `core/gate.ts` already triggers on that case via
 * `lastRunAt`, so this only needs to answer the "has anything changed" question.
 */
export function hasNewRunsSince(runRoots: string[], since: Date | null): boolean {
  if (!since) return true;
  const sinceMs = since.getTime();
  return runRoots.some((root) => newestRunJsonMtimeMs(root) > sinceMs);
}
