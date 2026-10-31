import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeRunStats, formatRunStats, confidenceBand } from "../../src/core/runStats";

describe("runStats", () => {
  let root: string;
  const now = new Date(2026, 9, 29, 12, 0, 0); // 2026-10-29

  const writeRun = (date: string, opts: { sub?: string; cost?: number | null; calls?: number; dry?: boolean; events?: object[] } = {}) => {
    const dir = path.join(root, date, ...(opts.sub ? [opts.sub] : []));
    fs.mkdirSync(dir, { recursive: true });
    const summary = {
      run_id: "r",
      script: "s",
      dry_run: opts.dry ?? false,
      model_calls: { count: opts.calls ?? 0, est_cost_usd: opts.cost === undefined ? 0 : opts.cost },
    };
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(summary));
    fs.writeFileSync(path.join(dir, "run.jsonl"), (opts.events ?? []).map((e) => JSON.stringify({ ts: "x", run_id: "r", ...e })).join("\n") + "\n");
  };
  const verdict = (subject: string, label: string, confidence: number) => ({ event: "verdict", skill: "financial/ltq", subject, label, confidence });
  const gate = (run: boolean) => ({ event: "gate", skill: "financial/ltq", subject: "X", run });
  const target = () => [{ domain: "financial", script: "daily", runsRoot: root }];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-runstats-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("sums cost and model calls per window, ignoring dry runs and runs outside the window", () => {
    writeRun("2026-10-28", { cost: 0.25, calls: 8 });
    writeRun("2026-10-27", { cost: 0.5, calls: 9 });
    writeRun("2026-10-20", { cost: 1, calls: 2 }); // in 30d, outside 7d
    writeRun("2026-10-26", { cost: 9, calls: 9, dry: true });
    writeRun("2026-08-01", { cost: 50, calls: 50 }); // outside both
    const [s] = computeRunStats(target(), now).scripts;
    expect(s.windows[0]).toMatchObject({ days: 7, runs: 2, model_calls: 17, cost_usd: 0.75 });
    expect(s.windows[1]).toMatchObject({ days: 30, runs: 3, model_calls: 19, cost_usd: 1.75 });
  });

  it("counts runs with unknown cost separately instead of summing them", () => {
    writeRun("2026-10-28", { cost: null, calls: 1 });
    writeRun("2026-10-27", { cost: 0.5, calls: 1 });
    const w = computeRunStats(target(), now).scripts[0].windows[0];
    expect(w.cost_usd).toBe(0.5);
    expect(w.unknown_cost_runs).toBe(1);
  });

  it("computes the gate skip ratio, and null with no gate events", () => {
    writeRun("2026-10-28", { events: [gate(false), gate(false), gate(true), gate(false)] });
    expect(computeRunStats(target(), now).scripts[0].windows[0]).toMatchObject({ gate_evaluations: 4, gate_skips: 3, gate_skip_ratio: 0.75 });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-runstats-empty-"));
    const w = computeRunStats([{ domain: "d", script: "s", runsRoot: empty }], now).scripts[0].windows[0];
    fs.rmSync(empty, { recursive: true, force: true });
    expect(w.gate_skip_ratio).toBeNull();
    expect(w.redundancy_ratio).toBeNull();
  });

  it("flags a verdict as redundant when label and confidence band match the previous call for the same subject", () => {
    writeRun("2026-10-26", { events: [verdict("GOOG", "BUY", 0.68), verdict("DELL", "HOLD", 0.5)] });
    writeRun("2026-10-27", { events: [verdict("GOOG", "BUY", 0.72), verdict("DELL", "HOLD", 0.55)] }); // GOOG new band, DELL same
    writeRun("2026-10-28", { events: [verdict("DELL", "BUY", 0.55)] }); // label changed
    const w = computeRunStats(target(), now).scripts[0].windows[0];
    expect(w.verdict_comparable).toBe(3);
    expect(w.verdict_redundant).toBe(1);
    expect(w.redundancy_ratio).toBeCloseTo(1 / 3);
  });

  it("compares the first call in the 7d window against a prior call from outside it", () => {
    writeRun("2026-10-10", { events: [verdict("GOOG", "BUY", 0.7)] });
    writeRun("2026-10-28", { events: [verdict("GOOG", "BUY", 0.75)] });
    const [s] = computeRunStats(target(), now).scripts;
    expect(s.windows[0]).toMatchObject({ verdict_comparable: 1, verdict_redundant: 1 });
    expect(s.windows[1]).toMatchObject({ verdict_comparable: 1, verdict_redundant: 1 });
  });

  it("reads multi-run-a-day layouts and rolls scripts up per domain", () => {
    writeRun("2026-10-28", { sub: "070000", cost: 0.1, calls: 1 });
    writeRun("2026-10-28", { sub: "080000", cost: 0.2, calls: 2 });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-runstats-b-"));
    fs.mkdirSync(path.join(other, "2026-10-28"), { recursive: true });
    fs.writeFileSync(
      path.join(other, "2026-10-28", "run.json"),
      JSON.stringify({ dry_run: false, model_calls: { count: 4, est_cost_usd: 0.4 } })
    );
    const result = computeRunStats(
      [
        { domain: "financial", script: "swing", runsRoot: root },
        { domain: "financial", script: "daily", runsRoot: other },
      ],
      now
    );
    fs.rmSync(other, { recursive: true, force: true });
    expect(result.scripts[0].windows[0]).toMatchObject({ runs: 2, model_calls: 3, cost_usd: 0.3 });
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0].windows[0]).toMatchObject({ runs: 3, model_calls: 7, cost_usd: 0.7 });
  });

  it("is a no-op for a missing runs root and formats readable text", () => {
    const result = computeRunStats([{ domain: "calendar", script: "none", runsRoot: path.join(root, "nope") }], now);
    expect(result.scripts[0].windows[0].runs).toBe(0);
    expect(formatRunStats(result)).toContain("n/a (no gate evaluations)");
  });

  it("bands confidence in 0.1 steps", () => {
    expect(confidenceBand(0.68)).toBe(6);
    expect(confidenceBand(0.7)).toBe(7);
    expect(confidenceBand(0.5)).toBe(5);
  });
});
