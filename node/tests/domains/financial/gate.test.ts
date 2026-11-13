import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openTestDb } from "../../helpers/testDb";
import { Db } from "../../../src/core/db";
import { computeGateFacts, gateFacts } from "../../../src/domains/financial/gate";
import { evaluateGate } from "../../../src/core/gate";
import { resetConfig } from "../../../src/core/config";
import { financialRunRoots } from "../../../src/domains/financial/runExpectations";

describe("computeGateFacts", () => {
  let tmp: string;
  let db: Db;
  let reportsDir: string;
  let brainFile: string;
  const now = new Date("2026-10-08T15:30:00Z");
  const opts = () => ({ reportsDir, brainFile, now });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-gate-"));
    db = await openTestDb();
    await db.addTicker("INTU", "INTU", "PUBLIC");
    reportsDir = path.join(tmp, "reports");
    fs.mkdirSync(reportsDir);
    brainFile = path.join(tmp, "INTU.md");
  });
  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads RSI and price from the latest stored quote", async () => {
    await db.addQuote("INTU", "2026-10-08", 1, 1, 1, 289.8, 1, 40.02, null, null);
    const f = await computeGateFacts(db, "long-term-quality", "intu", opts());
    expect(f.rsi).toBe(40.02);
    expect(f.price).toBe(289.8);
    expect(f.lastRunAt).toBeNull();
  });

  it("ignores a quote too old to gate on (so the skill runs)", async () => {
    await db.addQuote("INTU", "2026-09-20", 1, 1, 1, 289.8, 1, 40.02, null, null);
    const f = await computeGateFacts(db, "long-term-quality", "INTU", opts());
    expect(f.rsi).toBeNull();
    expect(f.price).toBeNull();
  });

  it("finds the last run for this skill only, and the price back then", async () => {
    await db.addQuote("INTU", "2026-10-08", 1, 1, 1, 290, 1, 45, null, null);
    await db.addQuote("INTU", "2026-10-06", 1, 1, 1, 275, 1, 31, null, null);
    await db.addSignal("INTU", "2026-10-06T08:00:00.000Z", "BUY", 0.6, "[Long-term] cheap", false);
    await db.addSignal("INTU", "2026-10-07T08:00:00.000Z", "HOLD", 0.5, "[Swing] neutral", false);
    const longTerm = await computeGateFacts(db, "long-term-quality", "INTU", opts());
    expect(longTerm.lastRunAt?.toISOString()).toBe("2026-10-06T08:00:00.000Z");
    expect(longTerm.lastRunPrice).toBe(275);
    expect(longTerm.lastRunRsi).toBe(31);
    const swing = await computeGateFacts(db, "swing-trading-large-cap", "INTU", opts());
    expect(swing.lastRunAt?.toISOString()).toBe("2026-10-07T08:00:00.000Z");
  });

  it("flags inputs changed after the last run (new report or brain-file edit)", async () => {
    await db.addQuote("INTU", "2026-10-08", 1, 1, 1, 290, 1, 45, null, null);
    await db.addSignal("INTU", "2026-10-06T08:00:00.000Z", "BUY", 0.6, "[Long-term] cheap", false);
    expect((await computeGateFacts(db, "long-term-quality", "INTU", opts())).inputsUpdatedAfterLastRun).toBe(false);

    fs.writeFileSync(path.join(reportsDir, "INTU-morningstar.pdf"), "x");
    fs.utimesSync(path.join(reportsDir, "INTU-morningstar.pdf"), new Date("2026-10-07T00:00:00Z"), new Date("2026-10-07T00:00:00Z"));
    expect((await computeGateFacts(db, "long-term-quality", "INTU", opts())).inputsUpdatedAfterLastRun).toBe(true);
  });

  it("flags long-term-quality as having no usable context when there is no Morningstar row or PDF", async () => {
    const f = await computeGateFacts(db, "long-term-quality", "INTU", opts());
    expect(f.noUsableContext).toContain("INTU");
    expect(evaluateGate({ rsiBelow: 40 }, { ...f, rsi: 20 })).toEqual({
      run: false,
      reasons: [expect.stringContaining("no usable context")],
    });
  });

  it("clears it once a report PDF or a cached Morningstar row exists, and never sets it for swing", async () => {
    expect((await computeGateFacts(db, "swing-trading-large-cap", "INTU", opts())).noUsableContext).toBeNull();

    fs.writeFileSync(path.join(reportsDir, "INTU-morningstar.pdf"), "x");
    expect((await computeGateFacts(db, "long-term-quality", "INTU", opts())).noUsableContext).toBeNull();
    fs.rmSync(path.join(reportsDir, "INTU-morningstar.pdf"));

    await db.addFundamentals({
      ticker: "INTU", as_of_date: "2026-10-01", source: "morningstar", pe_ratio: null, pb_ratio: null,
      debt_to_equity: null, fcf: null, fcf_fiscal_year: null, fcf_yield: null, fcf_margin: null,
      fcf_positive: null, dividend_yield: null, earnings_growth: null, revenue_growth: null, fair_value: null,
      price_to_fair_value: null, economic_moat: null, morningstar_rating: null, uncertainty: null,
      capital_allocation: null, red_flags: null,
    } as never);
    expect((await computeGateFacts(db, "long-term-quality", "INTU", opts())).noUsableContext).toBeNull();
  });

  it("knows nothing about an unrecognized skill", async () => {
    expect((await computeGateFacts(db, "some-other-skill", "INTU", opts())).lastRunAt).toBeNull();
  });

  it("uses gate_runs (including NONE verdicts) as lastRunRsi/lastRunPrice even when signals is empty", async () => {
    await db.recordGateRun({
      ticker: "INTU",
      skill: "swing-trading-large-cap",
      runAt: "2026-10-07T08:00:00.000Z",
      verdict: "NONE",
      rsi: 26.98,
      price: 600,
    });
    const f = await computeGateFacts(db, "swing-trading-large-cap", "INTU", opts());
    expect(f.lastRunAt?.toISOString()).toBe("2026-10-07T08:00:00.000Z");
    expect(f.lastRunRsi).toBe(26.98);
    expect(f.lastRunPrice).toBe(600);
  });

  it("skips long-term-quality for a watchlist ticker with no recorded thesis (with Buffett research guidance), and clears once a thesis is written", async () => {
    fs.writeFileSync(path.join(reportsDir, "INTU-morningstar.pdf"), "x");
    await db.addWatchlist("INTU", "");

    // Missing brain file -> skipped with Buffett research prompt
    const missing = await computeGateFacts(db, "long-term-quality", "INTU", opts());
    expect(missing.noUsableContext).toContain("watchlist ticker INTU has no recorded thesis");
    expect(missing.noUsableContext).toContain("5 Buffett owner pillars");
    expect(evaluateGate({ rsiBelow: 40 }, { ...missing, rsi: 25 })).toEqual({
      run: false,
      reasons: [expect.stringContaining("no usable context")],
    });

    // Empty placeholder thesis -> still skipped
    fs.writeFileSync(
      brainFile,
      "# INTU\n\n## Your thesis (compiled truth)\n\n_No thesis recorded yet. Add one via the CLI._\n"
    );
    expect((await computeGateFacts(db, "long-term-quality", "INTU", opts())).noUsableContext).toContain(
      "watchlist ticker INTU has no recorded thesis"
    );

    // Swing is never blocked by a missing long-term thesis
    expect((await computeGateFacts(db, "swing-trading-large-cap", "INTU", opts())).noUsableContext).toBeNull();

    // Writing a real owner thesis clears the gate skip immediately
    fs.writeFileSync(
      brainFile,
      '# INTU\n\n## Your thesis (compiled truth)\n\n> "High switching-cost SMB bookkeeping & tax ecosystem."\n'
    );
    expect((await computeGateFacts(db, "long-term-quality", "INTU", opts())).noUsableContext).toBeNull();
  });

  it("never skips long-term-quality for a held position even when its thesis is missing", async () => {
    fs.writeFileSync(path.join(reportsDir, "INTU-morningstar.pdf"), "x");
    await db.addPosition("INTU", 10, 500, "2026-06-02");
    await db.addWatchlist("INTU", "");

    const f = await computeGateFacts(db, "long-term-quality", "INTU", opts());
    expect(f.noUsableContext).toBeNull();
  });

  it("tracks buffett-value ([Buffett]) independently from long-term-quality and swing, and enforces fundamentals & watchlist thesis gates", async () => {
    await db.addQuote("INTU", "2026-10-08", 1, 1, 1, 290, 1, 45, null, null);
    await db.addQuote("INTU", "2026-10-05", 1, 1, 1, 260, 1, 34, null, null);
    await db.addSignal("INTU", "2026-10-07T08:00:00.000Z", "HOLD", 0.7, "[Long-term] growth intact", false);
    await db.addSignal("INTU", "2026-10-05T08:00:00.000Z", "BUY", 0.8, "[Buffett] wide moat at 0.82x fair value", false);

    // Without Morningstar data, buffett-value has noUsableContext
    expect((await computeGateFacts(db, "buffett-value", "INTU", opts())).noUsableContext).toContain("INTU");

    // With Morningstar PDF, it reads the [Buffett] signal history (not [Long-term])
    fs.writeFileSync(path.join(reportsDir, "INTU-morningstar.pdf"), "x");
    const buffettFacts = await computeGateFacts(db, "buffett-value", "INTU", opts());
    expect(buffettFacts.noUsableContext).toBeNull();
    expect(buffettFacts.lastRunAt?.toISOString()).toBe("2026-10-05T08:00:00.000Z");
    expect(buffettFacts.lastRunPrice).toBe(260);
    expect(buffettFacts.lastRunRsi).toBe(34);

    // Unanchored watchlist ticker is skipped for buffett-value too, while held positions run
    await db.addWatchlist("INTU", "");
    expect((await computeGateFacts(db, "buffett-value", "INTU", opts())).noUsableContext).toContain(
      "watchlist ticker INTU has no recorded thesis"
    );
    await db.addPosition("INTU", 10, 500, "2026-06-02");
    expect((await computeGateFacts(db, "buffett-value", "INTU", opts())).noUsableContext).toBeNull();
  });
});
