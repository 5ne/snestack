import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  gatherReflectionDigest,
  runCheckFindingsSource,
  runSummariesSource,
  existingFeatureRequestsSource,
  readLastReflectRun,
  recordReflectRun,
  hasNewRunsSince,
  type ReflectOpts,
  type DigestSource,
} from "../../src/core/reflect";
import { writeProposals } from "../../src/core/featureRequests";
import type { RunExpectation } from "../../src/core/runCheck";
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

describe("gatherReflectionDigest", () => {
  const opts: ReflectOpts = { domain: "financial", brainRoot: "/unused", now: new Date(2026, 9, 13), days: 7 };

  it("reports an explicit all-quiet message when every source is empty", () => {
    const sources: DigestSource[] = [{ name: "a", fetch: () => "" }, { name: "b", fetch: () => "   " }];
    expect(gatherReflectionDigest(sources, opts)).toBe("(nothing to report from any source — all quiet.)");
  });

  it("concatenates each non-empty source under its own heading, skipping empty ones", () => {
    const sources: DigestSource[] = [
      { name: "empty-source", fetch: () => "" },
      { name: "has-content", fetch: () => "- something happened" },
    ];
    const digest = gatherReflectionDigest(sources, opts);
    expect(digest).toContain("### has-content");
    expect(digest).toContain("- something happened");
    expect(digest).not.toContain("empty-source");
  });
});

describe("runCheckFindingsSource", () => {
  let runsRoot: string;
  const now = new Date(2026, 9, 7, 12, 0, 0); // Wed 2026-10-07, after grace hour

  beforeEach(() => {
    runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-reflect-runs-"));
  });
  afterEach(() => fs.rmSync(runsRoot, { recursive: true, force: true }));

  const expectation = (): RunExpectation => ({
    name: "financial",
    runsRoot,
    expectedOn: (d) => d.getDay() >= 1 && d.getDay() <= 5,
    graceHour: 10,
  });

  it("is empty when passed no expectations (a domain with nothing wired up yet)", () => {
    const source = runCheckFindingsSource([]);
    const opts: ReflectOpts = { domain: "calendar", brainRoot: "/unused", now, days: 7 };
    expect(source.fetch(opts)).toBe("");
  });

  it("formats run-check findings as a bulleted list", () => {
    // No run recorded for 2026-10-07 (today) or 10-06 -> missing_run findings.
    const source = runCheckFindingsSource([expectation()]);
    const opts: ReflectOpts = { domain: "financial", brainRoot: "/unused", now, days: 2 };
    const text = source.fetch(opts);
    expect(text).toContain("[error]");
    expect(text).toContain("missing_run");
  });

  it("includes cache-staleness findings when staleness config is passed", () => {
    const source = runCheckFindingsSource([], {
      tickers: ["AAPL"],
      getLatestQuoteAge: () => 72 * 60 * 60 * 1000,
      getLatestFundamentalsAge: () => 1 * 60 * 60 * 1000,
    });
    const opts: ReflectOpts = { domain: "financial", brainRoot: "/unused", now, days: 2 };
    expect(source.fetch(opts)).toContain("cache_stale");
  });
});

describe("runSummariesSource", () => {
  let root: string;
  const now = new Date(2026, 9, 13, 12, 0, 0); // 2026-10-13

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-reflect-summaries-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const opts: ReflectOpts = { domain: "financial", brainRoot: "/unused", now, days: 7 };

  it("is empty for a run root that doesn't exist", () => {
    expect(runSummariesSource([path.join(root, "nope")]).fetch(opts)).toBe("");
  });

  it("summarizes a single-run-per-day layout", () => {
    const dir = path.join(root, "2026-10-12");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(summary()));
    const text = runSummariesSource([root]).fetch(opts);
    expect(text).toContain("2026-10-12");
    expect(text).toContain("status=ok");
    expect(text).toContain("cost=$0.50");
  });

  it("summarizes a multi-run-per-day layout and surfaces failures", () => {
    const dayDir = path.join(root, "2026-10-12");
    fs.mkdirSync(path.join(dayDir, "093000"), { recursive: true });
    fs.writeFileSync(path.join(dayDir, "093000", "run.json"), JSON.stringify(summary()));
    fs.mkdirSync(path.join(dayDir, "113000"), { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, "113000", "run.json"),
      JSON.stringify(summary({ status: "failed", steps: { total: 1, ok: 0, failed: 1, truncated: 0, skipped: 0, retried: 0 } }))
    );
    const text = runSummariesSource([root]).fetch(opts);
    expect(text).toContain("2026-10-12 093000");
    expect(text).toContain("2026-10-12 113000");
    expect(text).toContain("failed_steps=1");
  });

  it("excludes days outside the lookback window", () => {
    const dir = path.join(root, "2026-09-01");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(summary()));
    expect(runSummariesSource([root]).fetch(opts)).toBe("");
  });
});

describe("existingFeatureRequestsSource", () => {
  let brainRoot: string;
  const now = new Date(2026, 9, 13, 12, 0, 0);

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-reflect-features-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  it("is empty for a domain with no feature-requests yet", () => {
    const opts: ReflectOpts = { domain: "calendar", brainRoot, now, days: 7 };
    expect(existingFeatureRequestsSource().fetch(opts)).toBe("");
  });

  it("lists every existing proposal with status, impact, and effort", () => {
    writeProposals(
      brainRoot,
      "financial",
      [
        {
          title: "Add retry backoff to data-refresh",
          impact: "medium",
          effort: "small",
          evidence: "429s three days running.",
          body: "Add backoff.",
        },
      ],
      { now }
    );
    const opts: ReflectOpts = { domain: "financial", brainRoot, now, days: 7 };
    const text = existingFeatureRequestsSource().fetch(opts);
    expect(text).toContain("[proposed]");
    expect(text).toContain("Add retry backoff to data-refresh");
    expect(text).toContain("impact=medium");
    expect(text).toContain("effort=small");
  });
});

describe("readLastReflectRun / recordReflectRun", () => {
  let brainRoot: string;

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-reflect-marker-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  it("returns null when improve-self has never run", () => {
    expect(readLastReflectRun(brainRoot, "financial")).toBeNull();
  });

  it("round-trips the timestamp recordReflectRun writes", () => {
    const at = new Date("2026-10-10T08:00:00Z");
    recordReflectRun(brainRoot, "financial", at);
    expect(readLastReflectRun(brainRoot, "financial")?.toISOString()).toBe(at.toISOString());
  });

  it("returns null for a corrupt marker file instead of throwing", () => {
    const dir = path.join(brainRoot, "financial", "feature-requests");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".last-run.json"), "not json");
    expect(readLastReflectRun(brainRoot, "financial")).toBeNull();
  });

  it("tracks domains independently", () => {
    recordReflectRun(brainRoot, "financial", new Date("2026-10-10T08:00:00Z"));
    expect(readLastReflectRun(brainRoot, "calendar")).toBeNull();
  });
});

describe("hasNewRunsSince", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-reflect-newruns-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("is true unconditionally when there's no previous run on record", () => {
    expect(hasNewRunsSince([root], null)).toBe(true);
  });

  it("is false when nothing in any run root is newer than `since`", () => {
    const dir = path.join(root, "2026-10-01");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run.json"), "{}");
    fs.utimesSync(path.join(dir, "run.json"), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    expect(hasNewRunsSince([root], new Date("2026-10-05T00:00:00Z"))).toBe(false);
  });

  it("is true when a multi-run-per-day subdirectory's run.json is newer than `since`", () => {
    const dir = path.join(root, "2026-10-10", "093000");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run.json"), "{}");
    expect(hasNewRunsSince([root], new Date("2026-10-05T00:00:00Z"))).toBe(true);
  });
});
