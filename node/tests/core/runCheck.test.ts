import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  evaluateRuns,
  checkCacheStaleness,
  isFinnhubFundamentalsFresh,
  elapsedMarketMs,
  type RunExpectation,
} from "../../src/core/runCheck";
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
    steps: { total: 3, ok: 3, failed: 0, truncated: 0, skipped: 0, retried: 0 },
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

  it("collapses simultaneous missing_run findings across automations into one host_outage finding", () => {
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-runcheck-b-"));
    try {
      const writeB = (date: string, s: RunSummary) => {
        const dir = path.join(rootB, date);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(s));
      };
      writeRun("2026-10-02", summary({ started_at: "2026-10-02T15:30:00Z" }));
      writeB("2026-10-02", summary({ started_at: "2026-10-02T15:40:00Z" }));
      // 10-05 and 10-06 missing for both; 10-07 resumed
      writeRun("2026-10-07", summary({ started_at: "2026-10-07T15:30:00Z" }));
      writeB("2026-10-07", summary({ started_at: "2026-10-07T15:40:00Z" }));
      const findings = evaluateRuns({
        now,
        days: 6,
        expectations: [expectation(), expectation({ name: "financial-daily-refresh", runsRoot: rootB })],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ code: "host_outage", severity: "error", date: "2026-10-06" });
      expect(findings[0].message).toContain("2026-10-05 to 2026-10-06");
      expect(findings[0].message).toContain("2026-10-02T15:40:00.000Z");
      expect(findings[0].message).toContain("2026-10-07T15:30:00.000Z");
    } finally {
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("keeps a plain missing_run when only some automations are missing", () => {
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-runcheck-b-"));
    try {
      writeRun("2026-10-07", summary());
      writeRun("2026-10-06", summary());
      fs.mkdirSync(path.join(rootB, "2026-10-07"), { recursive: true });
      fs.writeFileSync(path.join(rootB, "2026-10-07", "run.json"), JSON.stringify(summary()));
      const findings = evaluateRuns({
        now,
        days: 2,
        expectations: [expectation(), expectation({ name: "other", runsRoot: rootB })],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ code: "missing_run", domain: "other", date: "2026-10-06" });
    } finally {
      fs.rmSync(rootB, { recursive: true, force: true });
    }
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
        steps: { total: 3, ok: 2, failed: 1, truncated: 0, skipped: 0, retried: 0 },
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

  describe("minRunsPerDay (multi-run-a-day automations)", () => {
    const writeMultiRun = (date: string, time: string, s: RunSummary) => {
      const dir = path.join(root, date, time);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "run.jsonl"), "{}\n");
      fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(s));
    };

    it("reports nothing when enough runs landed today, all ok", () => {
      writeMultiRun("2026-10-07", "093000", summary());
      writeMultiRun("2026-10-07", "103000", summary());
      writeMultiRun("2026-10-07", "113000", summary());
      const findings = evaluateRuns({
        now,
        days: 1,
        expectations: [expectation({ minRunsPerDay: 3 })],
      });
      expect(findings).toEqual([]);
    });

    it("errors when zero runs landed on an expected day", () => {
      const findings = evaluateRuns({ now, days: 1, expectations: [expectation({ minRunsPerDay: 3 })] });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: "error", code: "missing_run" });
    });

    it("warns (not errors) when fewer than the minimum ran", () => {
      writeMultiRun("2026-10-07", "093000", summary());
      const findings = evaluateRuns({ now, days: 1, expectations: [expectation({ minRunsPerDay: 3 })] });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: "warn", code: "missing_run" });
    });

    it("surfaces a failed step from one of several runs, labeled by its run time", () => {
      writeMultiRun("2026-10-07", "093000", summary());
      writeMultiRun(
        "2026-10-07",
        "103000",
        summary({
          status: "failed",
          steps: { total: 1, ok: 0, failed: 1, truncated: 0, skipped: 0, retried: 0 },
          failed_steps: [{ step: "data-refresh", subject: "all", exit_code: 1, error: "rate limited" }],
        })
      );
      writeMultiRun("2026-10-07", "113000", summary());
      const findings = evaluateRuns({ now, days: 1, expectations: [expectation({ minRunsPerDay: 3 })] });
      const failed = findings.find((f) => f.code === "failed");
      expect(failed).toBeDefined();
      expect(failed!.message).toContain("103000");
      expect(failed!.message).toContain("rate limited");
    });

    it("does not flag cost anomalies in multi-run mode", () => {
      writeMultiRun("2026-10-07", "093000", summary({ model_calls: { ...summary().model_calls, est_cost_usd: 50 } }));
      writeMultiRun("2026-10-07", "103000", summary());
      writeMultiRun("2026-10-07", "113000", summary());
      const findings = evaluateRuns({ now, days: 1, expectations: [expectation({ minRunsPerDay: 3 })] });
      expect(findings.some((f) => f.code === "cost_anomaly")).toBe(false);
    });
  });
});

describe("checkCacheStaleness", () => {
  const now = new Date(2026, 9, 7, 12, 0, 0);
  const hoursAgoMs = (h: number) => h * 60 * 60 * 1000;
  const daysAgoMs = (d: number) => d * 24 * 60 * 60 * 1000;

  it("reports nothing when every ticker's cache is fresh", () => {
    const findings = checkCacheStaleness({
      now,
      tickers: ["AAPL", "NVDA"],
      getLatestQuoteAge: () => hoursAgoMs(1),
      getLatestFundamentalsAge: (ticker, source) => (source === "finnhub" ? hoursAgoMs(1) : daysAgoMs(1)),
    });
    expect(findings).toEqual([]);
  });

  it("flags a ticker with a stale or missing quote/fundamentals row", () => {
    const findings = checkCacheStaleness({
      now,
      tickers: ["AAPL", "NVDA"],
      getLatestQuoteAge: (ticker) => (ticker === "AAPL" ? hoursAgoMs(72) : hoursAgoMs(1)),
      getLatestFundamentalsAge: (ticker, source) => {
        if (source === "finnhub") return hoursAgoMs(1);
        return ticker === "NVDA" ? null : daysAgoMs(1);
      },
    });
    expect(findings).toHaveLength(2);
    const quoteFinding = findings.find((f) => f.message.startsWith("quotes"));
    expect(quoteFinding?.message).toContain("AAPL");
    const morningstarFinding = findings.find((f) => f.message.startsWith("morningstar"));
    expect(morningstarFinding?.message).toContain("NVDA");
  });

  it("treats Friday Finnhub fundamentals as fresh on Monday morning across a weekend", () => {
    const friday = new Date(2026, 9, 30, 14, 0, 0); // Fri Oct 30, 2026 14:00
    const monday = new Date(2026, 10, 2, 7, 0, 0);  // Mon Nov 2, 2026 07:00 (~65h wall-clock)
    expect(isFinnhubFundamentalsFresh(friday.toISOString(), monday)).toBe(true);

    const wallAgeMs = monday.getTime() - friday.getTime();
    const findings = checkCacheStaleness({
      now: monday,
      tickers: ["INTU"],
      getLatestQuoteAge: () => hoursAgoMs(1),
      getLatestFundamentalsAge: (_t, source) => (source === "finnhub" ? wallAgeMs : daysAgoMs(1)),
    });
    expect(findings).toEqual([]);
  });

  it("flags Finnhub fundamentals as stale when weekday refreshes were missed (>48h trading)", () => {
    const wednesday = new Date(2026, 9, 28, 14, 0, 0); // Wed Oct 28, 2026 14:00
    const monday = new Date(2026, 10, 2, 7, 0, 0);     // Mon Nov 2, 2026 07:00 (Thu + Fri missed)
    expect(isFinnhubFundamentalsFresh(wednesday.toISOString(), monday)).toBe(false);

    const wallAgeMs = monday.getTime() - wednesday.getTime();
    const findings = checkCacheStaleness({
      now: monday,
      tickers: ["INTU"],
      getLatestQuoteAge: () => hoursAgoMs(1),
      getLatestFundamentalsAge: (_t, source) => (source === "finnhub" ? wallAgeMs : daysAgoMs(1)),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("cache_stale");
    expect(findings[0].message).toContain("finnhub fundamentals");
  });

  it("excludes US market holidays when measuring trading-day age", () => {
    // Fri Sep 4, 2026 14:00 -> Tue Sep 8, 2026 07:00 (Mon Sep 7 is Labor Day)
    const friday = new Date(2026, 8, 4, 14, 0, 0);
    const tuesday = new Date(2026, 8, 8, 7, 0, 0);
    expect(elapsedMarketMs(friday.getTime(), tuesday.getTime())).toBe(17 * 60 * 60 * 1000);
    expect(isFinnhubFundamentalsFresh(friday.toISOString(), tuesday)).toBe(true);
  });
});
