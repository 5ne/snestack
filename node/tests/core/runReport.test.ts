import { buildRunReport, formatRunReportText, formatDuration } from "../../src/core/runReport";
import type { RunEvent } from "../../src/core/runLog";

const T0 = Date.parse("2026-10-08T15:30:00.000Z");
const ev = (event: string, fields: Record<string, unknown> = {}, secs = 0): RunEvent => ({
  ts: new Date(T0 + secs * 1000).toISOString(),
  run_id: "r1",
  event,
  ...fields,
});

const quietDay: RunEvent[] = [
  ev("run_start", { script: "financial-daily", dry_run: false }),
  ev("step", { step: "data-dump", subject: "all", status: "ok", exit_code: 0 }, 5),
  ev("gate", { skill: "financial/long-term-quality", subject: "INTU", run: false, reasons: ["no trigger: RSI 49.6 inside 40-70"] }, 6),
  ev("step", { step: "run-skill:long-term-quality", subject: "INTU", status: "skipped", exit_code: 4 }, 6),
  ev("gate", { skill: "financial/swing-trading-large-cap", subject: "INTU", run: false, reasons: ["no trigger: RSI 49.6 inside 30-70"] }, 7),
  ev("step", { step: "run-skill:swing-trading-large-cap", subject: "INTU", status: "skipped", exit_code: 4 }, 7),
  ev("gate", { skill: "financial/long-term-quality", subject: "MSFT", run: true, reasons: ["RSI 73.85 is above 70"] }, 8),
  ev("model_call", { label: "financial/long-term-quality MSFT", model: "claude-sonnet-5-5", input_tokens: 3700, output_tokens: 1650, latency_ms: 13500 }, 22),
  ev("step", { step: "run-skill:long-term-quality", subject: "MSFT", status: "ok", exit_code: 0 }, 22),
];

describe("buildRunReport", () => {
  it("separates gated-off skips from calls that ran, with reasons, tokens and cost", () => {
    const r = buildRunReport(quietDay, new Date(T0 + 60_000));
    expect(r.status).toBe("ok");
    expect(r.subjects).toBe(2);
    expect(r.ran).toBe(1);
    expect(r.skipped).toEqual([
      { skill: "long-term-quality", subject: "INTU", reason: "no trigger: RSI 49.6 inside 40-70" },
      { skill: "swing-trading-large-cap", subject: "INTU", reason: "no trigger: RSI 49.6 inside 30-70" },
    ]);
    expect(r.totals.calls).toBe(1);
    expect(r.totals.inputTokens).toBe(3700);
    expect(r.totals.costUsd).toBeCloseTo((3700 * 2 + 1650 * 10) / 1e6, 4);
    expect(r.durationMs).toBe(60_000);
  });

  it("surfaces failures and truncations", () => {
    const r = buildRunReport([
      ev("run_start", { script: "financial-daily" }),
      ev("step", { step: "run-skill:long-term-quality", subject: "RIVN", status: "failed", exit_code: 1, error: "credit balance is too low" }),
      ev("step", { step: "run-skill:swing-trading-large-cap", subject: "NFLX", status: "truncated", exit_code: 3 }),
      ev("model_call", { label: "financial/long-term-quality RIVN", model: "claude-sonnet-5-5", error: "Error: 400 credit balance is too low" }),
    ]);
    expect(r.status).toBe("failed");
    expect(r.failures[0].subject).toBe("RIVN");
    expect(r.truncations).toEqual([{ step: "run-skill:swing-trading-large-cap", subject: "NFLX" }]);
    expect(r.ran).toBe(0);
    expect(r.calls[0].error).toContain("credit balance");
  });

  it("reports only the latest run when the log holds several", () => {
    const r = buildRunReport([
      ev("run_start", { script: "x" }),
      ev("step", { step: "s", subject: "a", status: "failed", exit_code: 1 }),
      { ...ev("run_start", { script: "x" }), run_id: "r2" },
      { ...ev("step", { step: "s", subject: "a", status: "ok", exit_code: 0 }), run_id: "r2" },
    ]);
    expect(r.status).toBe("ok");
  });
});

describe("formatRunReportText", () => {
  it("renders the summary with status, counts, cost, calls and skip reasons", () => {
    const text = formatRunReportText(buildRunReport(quietDay, new Date(T0 + 60_000)));
    expect(text).toContain("JOB RUN SUMMARY");
    expect(text).toContain("Status: OK · 1m 0s");
    expect(text).toContain("Checked 2 tickers: 1 analysis call ran, 2 skipped");
    expect(text).toContain("est. cost $0.02");
    expect(text).toContain("financial/long-term-quality MSFT");
    expect(text).toContain("INTU swing-trading-large-cap: no trigger: RSI 49.6 inside 30-70");
  });
  it("formats durations", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(null)).toBe("unknown");
  });
});
