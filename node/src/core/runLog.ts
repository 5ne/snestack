import * as fs from "fs";
import * as path from "path";

/**
 * Structured, machine-readable record of an automation run.
 *
 * A run (one invocation of an automation script) gets a directory and an ID,
 * passed to every process it spawns through SNESTACK_RUN_DIR / SNESTACK_RUN_ID.
 * Everything appends one JSON object per line to <dir>/run.jsonl: the shell
 * script logs step outcomes, and the executor logs every model call. `finalize`
 * folds the events into <dir>/run.json — a small summary a watcher can read
 * without parsing prose. With SNESTACK_RUN_DIR unset (ad-hoc CLI use) all of
 * this is a no-op.
 */

export interface RunEvent {
  ts: string;
  run_id: string | null;
  event: string;
  [key: string]: unknown;
}

export type RunStatus = "ok" | "degraded" | "failed";

export interface FailedStep {
  step: string;
  subject: string | null;
  exit_code: number | null;
  error: string | null;
}

export interface RunSummary {
  run_id: string | null;
  script: string | null;
  dry_run: boolean;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  status: RunStatus;
  script_exit_code: number | null;
  /** Counted by each step's latest attempt; `retried` is how many steps needed more than one attempt. */
  steps: { total: number; ok: number; failed: number; truncated: number; skipped: number; retried: number };
  failed_steps: FailedStep[];
  truncated_steps: Array<{ step: string; subject: string | null }>;
  model_calls: {
    count: number;
    errors: number;
    truncated: number;
    input_tokens: number;
    output_tokens: number;
    max_latency_ms: number;
    est_cost_usd: number | null;
    by_model: Record<string, { calls: number; input_tokens: number; output_tokens: number }>;
  };
}

// Approximate list prices in USD per million tokens (input, output), as published 2026-09.
// Used only for the run summary's cost estimate; unknown models produce a null estimate.
const PRICES_PER_MTOK: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES_PER_MTOK[model];
  if (!price) return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1e6;
}

export function currentRunDir(): string | null {
  return process.env.SNESTACK_RUN_DIR || null;
}

export function currentRunId(): string | null {
  return process.env.SNESTACK_RUN_ID || null;
}

/** Append one event to the active run's run.jsonl. Never throws — logging must not break a run. */
export function logRunEvent(event: string, fields: Record<string, unknown> = {}, dir = currentRunDir()): void {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line: RunEvent = { ts: new Date().toISOString(), run_id: currentRunId(), event, ...fields };
    fs.appendFileSync(path.join(dir, "run.jsonl"), JSON.stringify(line) + "\n");
  } catch {
    // intentionally swallowed
  }
}

export function readRunEvents(dir: string): RunEvent[] {
  const file = path.join(dir, "run.jsonl");
  if (!fs.existsSync(file)) return [];
  const events: RunEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // a torn last line from a killed process shouldn't hide the rest
    }
  }
  return events;
}

/** Fold one run's events into a summary. If several runs share the file, the run with the latest run_start wins. */
export function summarizeRun(events: RunEvent[], scriptExitCode: number | null = null): RunSummary {
  const starts = events.filter((e) => e.event === "run_start");
  const runId = starts.length ? starts[starts.length - 1].run_id : (events[0]?.run_id ?? null);
  const mine = events.filter((e) => e.run_id === runId);
  const start = mine.find((e) => e.event === "run_start");
  const end = [...mine].reverse().find((e) => e.event === "run_end");

  const steps = { total: 0, ok: 0, failed: 0, truncated: 0, skipped: 0, retried: 0 };
  const failed_steps: FailedStep[] = [];
  const truncated_steps: Array<{ step: string; subject: string | null }> = [];
  // A step retried after a failure counts by its latest attempt, so a recovered failure isn't a failed run.
  const latest = new Map<string, RunEvent>();
  const attempts = new Map<string, number>();
  for (const e of mine.filter((e) => e.event === "step")) {
    const key = `${e.step}|${e.subject ?? ""}`;
    latest.set(key, e);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  }
  steps.retried = [...attempts.values()].filter((n) => n > 1).length;
  for (const e of latest.values()) {
    steps.total++;
    const status = String(e.status);
    if (status === "ok") steps.ok++;
    else if (status === "skipped") steps.skipped++;
    else if (status === "truncated") {
      steps.truncated++;
      truncated_steps.push({ step: String(e.step), subject: (e.subject as string) ?? null });
    } else {
      steps.failed++;
      failed_steps.push({
        step: String(e.step),
        subject: (e.subject as string) ?? null,
        exit_code: typeof e.exit_code === "number" ? e.exit_code : null,
        error: (e.error as string) ?? null,
      });
    }
  }

  const model_calls: RunSummary["model_calls"] = {
    count: 0,
    errors: 0,
    truncated: 0,
    input_tokens: 0,
    output_tokens: 0,
    max_latency_ms: 0,
    est_cost_usd: 0,
    by_model: {},
  };
  for (const e of mine.filter((e) => e.event === "model_call")) {
    model_calls.count++;
    const model = String(e.model ?? "unknown");
    const input = typeof e.input_tokens === "number" ? e.input_tokens : 0;
    const output = typeof e.output_tokens === "number" ? e.output_tokens : 0;
    if (e.error) model_calls.errors++;
    if (e.truncated) model_calls.truncated++;
    model_calls.input_tokens += input;
    model_calls.output_tokens += output;
    if (typeof e.latency_ms === "number") model_calls.max_latency_ms = Math.max(model_calls.max_latency_ms, e.latency_ms);
    const slot = (model_calls.by_model[model] ||= { calls: 0, input_tokens: 0, output_tokens: 0 });
    slot.calls++;
    slot.input_tokens += input;
    slot.output_tokens += output;
    const cost = estimateCostUsd(model, input, output);
    if (cost == null) model_calls.est_cost_usd = null;
    else if (model_calls.est_cost_usd != null) model_calls.est_cost_usd += cost;
  }
  if (model_calls.est_cost_usd != null) model_calls.est_cost_usd = Math.round(model_calls.est_cost_usd * 10000) / 10000;

  let status: RunStatus = "ok";
  if (steps.truncated > 0 || model_calls.truncated > 0) status = "degraded";
  if (steps.failed > 0 || (scriptExitCode != null && scriptExitCode !== 0)) status = "failed";

  const started = start ? Date.parse(start.ts) : NaN;
  const ended = end ? Date.parse(end.ts) : NaN;
  return {
    run_id: runId,
    script: (start?.script as string) ?? null,
    dry_run: Boolean(start?.dry_run),
    started_at: start?.ts ?? null,
    ended_at: end?.ts ?? null,
    duration_ms: isFinite(started) && isFinite(ended) ? ended - started : null,
    status,
    script_exit_code: scriptExitCode,
    steps,
    failed_steps,
    truncated_steps,
    model_calls,
  };
}

/** Write run_end, then fold the run into <dir>/run.json (atomically). Returns the summary. */
export function finalizeRun(dir: string, scriptExitCode: number | null = null): RunSummary {
  logRunEvent("run_end", { script_exit_code: scriptExitCode }, dir);
  const summary = summarizeRun(readRunEvents(dir), scriptExitCode);
  const target = path.join(dir, "run.json");
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(summary, null, 2) + "\n");
  fs.renameSync(tmp, target);
  return summary;
}

/**
 * A short, useful error string from a step's stderr log: the last few lines that
 * aren't routine info/debug logging (where the actual failure message lives),
 * capped to the end of the text. Null if the log is empty.
 */
export function extractErrorSummary(text: string, maxChars = 400): string | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.filter((l) => !/\[(info|debug|verbose)\]/.test(l));
  const picked = (meaningful.length ? meaningful : lines).slice(-3).join(" | ");
  return picked ? picked.slice(-maxChars) : null;
}
