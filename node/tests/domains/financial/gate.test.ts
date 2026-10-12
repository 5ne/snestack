import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Db } from "../../../src/core/db";
import { computeGateFacts } from "../../../src/domains/financial/gate";

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
