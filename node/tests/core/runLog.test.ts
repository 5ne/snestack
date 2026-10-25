import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  logRunEvent,
  readRunEvents,
  summarizeRun,
  finalizeRun,
  estimateCostUsd,
  extractErrorSummary,
  type RunEvent,
} from "../../src/core/runLog";

describe("runLog", () => {
  let dir: string;
  const saved = { dir: process.env.SNESTACK_RUN_DIR, id: process.env.SNESTACK_RUN_ID };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-runlog-"));
    process.env.SNESTACK_RUN_ID = "run-1";
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.env.SNESTACK_RUN_DIR = saved.dir;
    process.env.SNESTACK_RUN_ID = saved.id;
    if (saved.dir === undefined) delete process.env.SNESTACK_RUN_DIR;
    if (saved.id === undefined) delete process.env.SNESTACK_RUN_ID;
  });

  it("is a no-op when no run directory is active", () => {
    delete process.env.SNESTACK_RUN_DIR;
    expect(() => logRunEvent("step", { step: "x" })).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("appends JSON lines with timestamp, run id and fields", () => {
    process.env.SNESTACK_RUN_DIR = dir;
    logRunEvent("step", { step: "data-dump", status: "ok" });
    logRunEvent("step", { step: "notify", status: "failed" });
    const events = readRunEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "step", run_id: "run-1", step: "data-dump", status: "ok" });
    expect(Date.parse(events[0].ts)).not.toBeNaN();
  });

  it("skips a torn trailing line instead of losing the whole log", () => {
    process.env.SNESTACK_RUN_DIR = dir;
    logRunEvent("step", { step: "a", status: "ok" });
    fs.appendFileSync(path.join(dir, "run.jsonl"), '{"ts":"2026-10-07T00:00:00Z","event":"st');
    expect(readRunEvents(dir)).toHaveLength(1);
  });

  const ev = (event: string, fields: Record<string, unknown> = {}, run_id = "run-1"): RunEvent => ({
    ts: "2026-10-07T08:30:00.000Z",
    run_id,
    event,
    ...fields,
  });

  it("summarizes steps and model calls, with a cost estimate", () => {
    const summary = summarizeRun([
      ev("run_start", { script: "financial-daily", dry_run: false }),
      ev("step", { step: "data-dump", subject: "all", status: "ok", exit_code: 0 }),
      ev("step", { step: "run-skill:long-term-quality", subject: "INTU", status: "ok", exit_code: 0 }),
      ev("model_call", { model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 100_000, latency_ms: 4000 }),
      ev("model_call", { model: "claude-haiku-4-5-20251001", input_tokens: 1_000_000, output_tokens: 0, latency_ms: 900 }),
      ev("run_end", {}),
    ]);
    expect(summary.status).toBe("ok");
    expect(summary.script).toBe("financial-daily");
    expect(summary.steps).toEqual({ total: 2, ok: 2, failed: 0, truncated: 0, skipped: 0, retried: 0 });
    expect(summary.model_calls.count).toBe(2);
    expect(summary.model_calls.max_latency_ms).toBe(4000);
    expect(summary.model_calls.by_model["claude-sonnet-5-5"].calls).toBe(1);
    // sonnet-5-5: 1M*$2 + 0.1M*$10 = $3.00 ; haiku: 1M*$1 = $1.00
    expect(summary.model_calls.est_cost_usd).toBeCloseTo(4.0, 4);
  });

  it("marks the run failed and lists failed steps with their error", () => {
    const summary = summarizeRun([
      ev("run_start", { script: "financial-daily" }),
      ev("step", { step: "run-skill:long-term-quality", subject: "RIVN", status: "failed", exit_code: 1, error: "401 invalid key" }),
      ev("run_end", {}),
    ]);
    expect(summary.status).toBe("failed");
    expect(summary.failed_steps).toEqual([
      { step: "run-skill:long-term-quality", subject: "RIVN", exit_code: 1, error: "401 invalid key" },
    ]);
  });

  it("marks the run degraded when output was truncated but nothing failed", () => {
    const summary = summarizeRun([
      ev("run_start", { script: "x" }),
      ev("step", { step: "run-skill:a", subject: "NFLX", status: "truncated", exit_code: 3 }),
      ev("model_call", { model: "claude-sonnet-5-5", truncated: true, input_tokens: 10, output_tokens: 8000 }),
      ev("run_end", {}),
    ]);
    expect(summary.status).toBe("degraded");
    expect(summary.truncated_steps).toEqual([{ step: "run-skill:a", subject: "NFLX" }]);
    expect(summary.model_calls.truncated).toBe(1);
  });

  it("counts a retried step by its latest attempt, so a recovered failure doesn't fail the run", () => {
    const summary = summarizeRun([
      ev("run_start", { script: "x" }),
      ev("step", { step: "run-skill:a", subject: "MSFT", status: "failed", exit_code: 5, error: "output file was empty" }),
      ev("step", { step: "run-skill:a", subject: "MSFT", status: "ok", exit_code: 0 }),
      ev("step", { step: "run-skill:a", subject: "GOOG", status: "failed", exit_code: 1 }),
      ev("step", { step: "run-skill:a", subject: "GOOG", status: "failed", exit_code: 1 }),
      ev("run_end", {}),
    ]);
    expect(summary.steps).toEqual({ total: 2, ok: 1, failed: 1, truncated: 0, skipped: 0, retried: 2 });
    expect(summary.failed_steps.map((f) => f.subject)).toEqual(["GOOG"]);
    expect(summary.status).toBe("failed");
  });

  it("treats a nonzero script exit code as failed even with no failed step (e.g. set -e abort)", () => {
    const summary = summarizeRun([ev("run_start", { script: "x" }), ev("run_end", {})], 2);
    expect(summary.status).toBe("failed");
  });

  it("reads the script exit code the log itself recorded at run_end", () => {
    const summary = summarizeRun([ev("run_start", { script: "x" }), ev("step", { step: "s", status: "ok", exit_code: 0 }), ev("run_end", { script_exit_code: 1 })]);
    expect(summary.status).toBe("failed");
    expect(summary.script_exit_code).toBe(1);
  });

  it("summarizes only the latest run when several share the file", () => {
    const summary = summarizeRun([
      ev("run_start", { script: "x" }, "old"),
      ev("step", { step: "s", status: "failed", exit_code: 1 }, "old"),
      ev("run_start", { script: "x" }, "new"),
      ev("step", { step: "s", status: "ok", exit_code: 0 }, "new"),
    ]);
    expect(summary.run_id).toBe("new");
    expect(summary.status).toBe("ok");
  });

  it("reports an unknown cost rather than a wrong one for unpriced models", () => {
    expect(estimateCostUsd("some-future-model", 1000, 1000)).toBeNull();
    const summary = summarizeRun([ev("run_start", {}), ev("model_call", { model: "some-future-model", input_tokens: 5, output_tokens: 5 })]);
    expect(summary.model_calls.est_cost_usd).toBeNull();
  });

  it("finalizeRun writes run_end and an atomic run.json", () => {
    process.env.SNESTACK_RUN_DIR = dir;
    logRunEvent("run_start", { script: "financial-daily" });
    logRunEvent("step", { step: "notify", subject: "all", status: "ok", exit_code: 0 });
    const summary = finalizeRun(dir, 0);
    expect(summary.status).toBe("ok");
    expect(summary.ended_at).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).script).toBe("financial-daily");
    expect(fs.existsSync(path.join(dir, "run.json.tmp"))).toBe(false);
  });
});

describe("extractErrorSummary", () => {
  it("skips routine info lines and returns the real failure", () => {
    const log = [
      '2026-10-07 08:30:04 [info] Fundamentals: INTU PE=19.33 {"label":"EquityAgent"}',
      '2026-10-07 08:30:06 [info] Quote: INTU @ $289.81 {"label":"QuoteAgent"}',
      'run-skill failed: Error: 400 {"message":"Your credit balance is too low"}',
    ].join("\n");
    expect(extractErrorSummary(log)).toBe('run-skill failed: Error: 400 {"message":"Your credit balance is too low"}');
  });
  it("drops stack frames so the error headline survives", () => {
    const log = [
      "DatabaseError: Failed to open database at /x/snestack.db: Error: database is locked",
      "    at new Db (/x/dist/core/db.js:57:19)",
      "    at Command._chainOrCall (/x/commander/lib/command.js:1386:12)",
    ].join("\n");
    expect(extractErrorSummary(log)).toBe("DatabaseError: Failed to open database at /x/snestack.db: Error: database is locked");
  });
  it("keeps only the last few meaningful lines", () => {
    expect(extractErrorSummary("a\nb\nc\nd\ne")).toBe("c | d | e");
  });
  it("falls back to whatever is there when everything is info, and caps the length", () => {
    expect(extractErrorSummary("[info] only info")).toBe("[info] only info");
    expect(extractErrorSummary("x".repeat(1000), 50)).toHaveLength(50);
  });
  it("returns null for an empty log", () => {
    expect(extractErrorSummary("  \n\n")).toBeNull();
  });
});
