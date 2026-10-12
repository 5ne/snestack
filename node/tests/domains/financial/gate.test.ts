import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Db } from "../../../src/core/db";
import { computeGateFacts, improveSelfGateFacts, gateFacts } from "../../../src/domains/financial/gate";
import { resetConfig } from "../../../src/core/config";
import { recordReflectRun } from "../../../src/core/reflect";
import { financialRunRoots } from "../../../src/domains/financial/runExpectations";

describe("computeGateFacts", () => {
  let tmp: string;
  let db: Db;
  let reportsDir: string;
  let brainFile: string;
  const now = new Date("2026-10-08T15:30:00Z");
  const opts = () => ({ reportsDir, brainFile, now });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-gate-"));
    db = new Db(path.join(tmp, "test.db"));
    db.addTicker("INTU", "INTU", "PUBLIC");
    reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir);
    brainFile = path.join(tmp, "INTU.md");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads RSI and price from the latest stored quote", () => {
    db.addQuote("INTU", "2026-10-08", 1, 1, 1, 289.8, 1, 40.02, null, null);
    const f = computeGateFacts(db, "long-term-quality", "intu", opts());
    expect(f.rsi).toBe(40.02);
    expect(f.price).toBe(289.8);
    expect(f.lastRunAt).toBeNull();
  });

  it("ignores a quote too old to gate on (so the skill runs)", () => {
    db.addQuote("INTU", "2026-09-20", 1, 1, 1, 289.8, 1, 40.02, null, null);
    const f = computeGateFacts(db, "long-term-quality", "INTU", opts());
    expect(f.rsi).toBeNull();
    expect(f.price).toBeNull();
  });

  it("finds the last run for this skill only, and the price back then", () => {
    db.addQuote("INTU", "2026-10-08", 1, 1, 1, 290, 1, 45, null, null);
    db.addQuote("INTU", "2026-10-06", 1, 1, 1, 275, 1, 31, null, null);
    db.addSignal("INTU", "2026-10-06T08:00:00.000Z", "BUY", 0.6, "[Long-term] cheap", false);
    db.addSignal("INTU", "2026-10-07T08:00:00.000Z", "HOLD", 0.5, "[Swing] neutral", false);
    const longTerm = computeGateFacts(db, "long-term-quality", "INTU", opts());
    expect(longTerm.lastRunAt?.toISOString()).toBe("2026-10-06T08:00:00.000Z");
    expect(longTerm.lastRunPrice).toBe(275);
    expect(longTerm.lastRunRsi).toBe(31);
    const swing = computeGateFacts(db, "swing-trading-large-cap", "INTU", opts());
    expect(swing.lastRunAt?.toISOString()).toBe("2026-10-07T08:00:00.000Z");
  });

  it("flags inputs changed after the last run (new report or brain-file edit)", () => {
    db.addQuote("INTU", "2026-10-08", 1, 1, 1, 290, 1, 45, null, null);
    db.addSignal("INTU", "2026-10-06T08:00:00.000Z", "BUY", 0.6, "[Long-term] cheap", false);
    expect(computeGateFacts(db, "long-term-quality", "INTU", opts()).inputsUpdatedAfterLastRun).toBe(false);

    fs.writeFileSync(path.join(reportsDir, "INTU-morningstar.pdf"), "x");
    fs.utimesSync(path.join(reportsDir, "INTU-morningstar.pdf"), new Date("2026-10-07T00:00:00Z"), new Date("2026-10-07T00:00:00Z"));
    expect(computeGateFacts(db, "long-term-quality", "INTU", opts()).inputsUpdatedAfterLastRun).toBe(true);
  });

  it("knows nothing about an unrecognized skill", () => {
    expect(computeGateFacts(db, "some-other-skill", "INTU", opts()).lastRunAt).toBeNull();
  });
});

describe("improveSelfGateFacts / gateFacts dispatch", () => {
  let brainRoot: string;
  const now = new Date("2026-10-13T12:00:00Z");

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-gate-improveself-"));
    process.env.SNESTACK_BRAIN_ROOT = brainRoot;
    resetConfig();
  });
  afterEach(() => {
    fs.rmSync(brainRoot, { recursive: true, force: true });
    delete process.env.SNESTACK_BRAIN_ROOT;
    resetConfig();
  });

  it("has no previous run and no price/RSI facts when improve-self has never run", () => {
    const f = improveSelfGateFacts(now);
    expect(f.lastRunAt).toBeNull();
    expect(f.rsi).toBeNull();
    expect(f.price).toBeNull();
    expect(f.inputsUpdatedAfterLastRun).toBe(true);
  });

  it("reads the last reflect-run marker once recorded", () => {
    const lastRun = new Date("2026-10-10T08:00:00Z");
    recordReflectRun(brainRoot, "financial", lastRun);
    expect(improveSelfGateFacts(now).lastRunAt?.toISOString()).toBe(lastRun.toISOString());
  });

  it("flags inputsUpdatedAfterLastRun when a run.json newer than the marker appears in a known run root", () => {
    const lastRun = new Date("2026-10-10T08:00:00Z");
    recordReflectRun(brainRoot, "financial", lastRun);
    expect(improveSelfGateFacts(now).inputsUpdatedAfterLastRun).toBe(false);

    const root = financialRunRoots(brainRoot)[0];
    const dayDir = path.join(root, "2026-10-11");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "run.json"), "{}");

    expect(improveSelfGateFacts(now).inputsUpdatedAfterLastRun).toBe(true);
  });

  it("gateFacts dispatches to improveSelfGateFacts for the improve-self skill", async () => {
    const f = await gateFacts("improve-self", "financial");
    expect(f.lastRunAt).toBeNull();
    expect(f.rsi).toBeNull();
  });
});
