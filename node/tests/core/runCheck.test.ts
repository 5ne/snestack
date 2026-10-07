import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { evaluateRuns, type RunExpectation } from "../../src/core/runCheck";
import type { RunSummary } from "../../src/core/runLog";

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "r",
    script: "financial-daily",
    dry_run: false,
    started_at: "2026-10-07T15:30:00Z",
    ended_at: "2026-10-07T15:35:00Z",
    duration_ms: 300000,
    status: "ok",
    script_exit_code: 0,
    steps: { total: 3, ok: 3, failed: 0, truncated: 0, skipped: 0 },
    failed_steps: [],
    truncated_steps: [],
    model_calls: { count: 3, errors: 0, truncated: 0, input_tokens: 1, output_tokens: 1, max_latency_ms: 1, est_cost_usd: 0.5, by_model: {} },
    ...over,
  };
}

describe("evaluateRuns", () => {
  let root: string;
  // Wednesday 2026-10-07, 12:00 local
  const now = new Date(2026, 9, 7, 12, 0, 0);

  const writeRun = (date: string, s?: RunSummary, jsonl = true) => {
    const dir = path.join(root, date);
    fs.mkdirSync(dir, { recursive: true });
    if (jsonl) fs.writeFileSync(path.join(dir, "run.jsonl"), "{}\n");
    if (s) fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(s));
  };
  const expectation = (over: Partial<RunExpectation> = {}): RunExpectation => ({
    name: "financial",
    runsRoot: root,
    expectedOn: (d) => d.getDay() >= 1 && d.getDay() <= 5,
    graceHour: 10,
    ...over,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-runcheck-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reports nothing when every expected run succeeded", () => {
    writeRun("2026-10-07", summary());
    writeRun("2026-10-06", summary());
    expect(evaluateRuns({ now, days: 2, expectations: [expectation()] })).toEqual([]);
  });

  it("flags a missing run on an expected day", () => {
    writeRun("2026-10-07", summary());
    const findings = evaluateRuns({ now, days: 2, expectations: [expectation()] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", code: "missing_run", date: "2026-10-06" });
  });

  it("does not expect a run on a weekend, or today before the grace hour", () => {
    const earlyMonday = new Date(2026, 9, 5, 9, 0, 0); // Mon Oct 5, 9am, before 10am grace
    expect(evaluateRuns({ now: earlyMonday, days: 3, expectations: [expectation()] })).toEqual([]);
  });

  it("flags a crashed run (run.jsonl but no run.json)", () => {
    writeRun("2026-10-07", undefined, true);
    const findings = evaluateRuns({ now, days: 1, expectations: [expectation()] });
    expect(findings[0]).toMatchObject({ severity: "error", code: "incomplete_run" });
  });

  it("flags failed runs with the failing step and subject", () => {
    writeRun(
      "2026-10-07",
      summary({
        status: "failed",
        steps: { total: 3, ok: 2, failed: 1, truncated: 0, skipped: 0 },
        failed_steps: [{ step: "run-skill:long-term-quality", subject: "RIVN", exit_code: 1, error: "401 invalid key" }],
      })
    );
    const f = evaluateRuns({ now, days: 1, expectations: [expectation()] })[0];
    expect(f).toMatchObject({ severity: "error", code: "failed" });
    expect(f.message).toContain("RIVN");
    expect(f.message).toContain("401 invalid key");
  });

  it("warns on truncation and on model errors", () => {
    writeRun(
      "2026-10-07",
      summary({
        status: "degraded",
        truncated_steps: [{ step: "run-skill:a", subject: "NFLX" }],
        model_calls: { count: 3, errors: 1, truncated: 1, input_tokens: 1, output_tokens: 1, max_latency_ms: 1, est_cost_usd: 0.5, by_model: {} },
      })
    );
    const codes = evaluateRuns({ now, days: 1, expectations: [expectation()] }).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["degraded", "model_errors"]));
  });

  it("warns when cost is more than 2x the median of earlier runs", () => {
    ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"].forEach((d) => writeRun(d, summary()));
    writeRun("2026-10-07", summary({ model_calls: { ...summary().model_calls, est_cost_usd: 1.5 } }));
    const f = evaluateRuns({ now, days: 1, expectations: [expectation()] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warn", code: "cost_anomaly" });
  });

  it("ignores dry-run folders and honors the since date", () => {
    writeRun("2026-10-07-dryrun", summary({ status: "failed" }));
    writeRun("2026-10-07", summary());
    expect(evaluateRuns({ now, days: 1, expectations: [expectation()] })).toEqual([]);
    expect(evaluateRuns({ now, days: 5, expectations: [expectation({ since: "2026-10-07" })] })).toEqual([]);
  });
});
