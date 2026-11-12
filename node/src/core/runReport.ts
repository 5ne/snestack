import { estimateCostUsd, summarizeRun, type FailedStep, type RunEvent, type RunStatus } from "./runLog";

/**
 * A human-readable picture of one automation run, built purely from its event
 * log (core/runLog.ts): what ran, what a gate skipped and why, what the model
 * calls cost, and what failed. Used for the "nothing changed" and "run had
 * problems" emails. No model call, so it is free and the same every time.
 */

export interface RunReportSkip {
  skill: string;
  subject: string;
  reason: string;
}

export interface RunReportCall {
  label: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number | null;
  truncated: boolean;
  error: string | null;
}

export interface RunReport {
  script: string | null;
  dryRun: boolean;
  status: RunStatus;
  startedAt: string | null;
  durationMs: number | null;
  steps: { total: number; ok: number; failed: number; truncated: number; skipped: number; retried: number };
  /** Distinct subjects (e.g. tickers) the run looked at. */
  subjects: number;
  skipped: RunReportSkip[];
  ran: number;
  calls: RunReportCall[];
  totals: { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null };
  failures: FailedStep[];
  truncations: Array<{ step: string; subject: string | null }>;
  /** The script's own exit code, once it has finished. */
  scriptExitCode: number | null;
}

export function buildRunReport(events: RunEvent[], now: Date = new Date()): RunReport {
  const summary = summarizeRun(events);
  const mine = events.filter((e) => e.run_id === summary.run_id);

  // Latest gate decision per (skill, subject).
  const gates = new Map<string, RunEvent>();
  for (const e of mine.filter((e) => e.event === "gate")) gates.set(`${e.skill}|${e.subject}`, e);
  const skipped: RunReportSkip[] = [...gates.values()]
    .filter((g) => g.run === false)
    .map((g) => ({
      skill: String(g.skill).split("/").pop() ?? String(g.skill),
      subject: String(g.subject),
      reason: Array.isArray(g.reasons) ? g.reasons.join("; ") : String(g.reasons ?? ""),
    }));

  const calls: RunReportCall[] = mine
    .filter((e) => e.event === "model_call")
    .map((e) => {
      const input = typeof e.input_tokens === "number" ? e.input_tokens : 0;
      const output = typeof e.output_tokens === "number" ? e.output_tokens : 0;
      return {
        label: String(e.label ?? "model call"),
        model: String(e.model ?? "unknown"),
        inputTokens: input,
        outputTokens: output,
        latencyMs: typeof e.latency_ms === "number" ? e.latency_ms : 0,
        costUsd:
          typeof e.est_cost_usd === "number"
            ? e.est_cost_usd
            : estimateCostUsd(String(e.model ?? ""), input, output),
        truncated: Boolean(e.truncated),
        error: e.error ? String(e.error) : null,
      };
    });

  const subjects = new Set(
    mine.filter((e) => e.event === "step" && String(e.step).startsWith("run-skill:")).map((e) => String(e.subject))
  );

  const started = summary.started_at ? Date.parse(summary.started_at) : NaN;
  const ended = summary.ended_at ? Date.parse(summary.ended_at) : now.getTime();

  return {
    script: summary.script,
    dryRun: summary.dry_run,
    status: summary.status,
    startedAt: summary.started_at,
    durationMs: isFinite(started) ? ended - started : null,
    steps: summary.steps,
    subjects: subjects.size,
    skipped,
    ran: calls.filter((c) => !c.error).length,
    calls,
    totals: {
      calls: summary.model_calls.count,
      inputTokens: summary.model_calls.input_tokens,
      outputTokens: summary.model_calls.output_tokens,
      costUsd: summary.model_calls.est_cost_usd,
    },
    failures: summary.failed_steps,
    truncations: summary.truncated_steps,
    scriptExitCode: summary.script_exit_code,
  };
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "unknown";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function formatCost(usd: number | null): string {
  return usd == null ? "unknown" : `$${usd.toFixed(2)}`;
}

/** Plain-text rendering of the run summary section. */
export function formatRunReportText(r: RunReport): string {
  const lines: string[] = [];
  lines.push("JOB RUN SUMMARY");
  lines.push(`Status: ${r.status.toUpperCase()} · ${formatDuration(r.durationMs)}${r.dryRun ? " · DRY RUN" : ""}`);
  lines.push(
    `Checked ${r.subjects} ticker${r.subjects === 1 ? "" : "s"}: ${r.ran} analysis call${r.ran === 1 ? "" : "s"} ran, ` +
      `${r.skipped.length} skipped because nothing had changed.`
  );
  lines.push(
    `Model usage: ${r.totals.calls} call${r.totals.calls === 1 ? "" : "s"}, ` +
      `${r.totals.inputTokens.toLocaleString("en-US")} tokens in / ${r.totals.outputTokens.toLocaleString("en-US")} out, ` +
      `est. cost ${formatCost(r.totals.costUsd)}`
  );
  if (r.status === "failed" && r.failures.length === 0) {
    lines.push("", `PROBLEM: the script stopped early (exit code ${r.scriptExitCode ?? "unknown"}) before any step reported a failure; see the run logs.`);
  }
  if (r.failures.length) {
    lines.push("", `PROBLEMS (${r.failures.length}):`);
    r.failures.forEach((f) =>
      lines.push(`  - ${f.step}${f.subject && f.subject !== "all" ? ` ${f.subject}` : ""}: ${f.error ?? `exit ${f.exit_code}`}`)
    );
  }
  if (r.truncations.length) {
    lines.push("", `CUT OFF at the token limit (${r.truncations.length}):`);
    r.truncations.forEach((t) => lines.push(`  - ${t.step}${t.subject ? ` ${t.subject}` : ""}`));
  }
  if (r.calls.length) {
    lines.push("", "Analysis that ran:");
    r.calls.forEach((c) =>
      lines.push(
        `  - ${c.label} (${c.model}): ${c.inputTokens.toLocaleString("en-US")} in / ${c.outputTokens.toLocaleString("en-US")} out, ` +
          `${(c.latencyMs / 1000).toFixed(1)}s, ${formatCost(c.costUsd)}${c.error ? ` — ERROR: ${c.error.slice(0, 160)}` : ""}`
      )
    );
  }
  if (r.skipped.length) {
    lines.push("", "Skipped (no model call needed):");
    r.skipped.forEach((s) => lines.push(`  - ${s.subject} ${s.skill}: ${s.reason}`));
  }
  return lines.join("\n");
}
