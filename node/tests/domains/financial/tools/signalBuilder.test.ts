import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openTestDb } from "../../../helpers/testDb";
import { Db } from "../../../../src/core/db";
import {
  buildSignalsFromDir,
  collectEvaluationsFromDir,
  filterUnchangedSignals,
  NO_THESIS_TAG,
  type BuiltSignal,
} from "../../../../src/domains/financial/tools/signalBuilder";

describe("buildSignalsFromDir", () => {
  let dir: string;
  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-signals-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("builds signals with the skill prefix, confidence and reasoning", async () => {
    write("INTU-long-term-quality.md", "text\nVERDICT: BUY | 0.6 | Cheap with a 40% FCF margin.\n");
    write("INTU-buffett-value.md", "text\nVERDICT: HOLD | 0.75 | Wide moat, wait for 0.85x fair value.\n");
    write("MSFT-swing-trading-large-cap.md", "text\nVERDICT: SELL | 0.65 | RSI 73.85 is overbought.\n");
    const r = buildSignalsFromDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.signals).toEqual([
      { ticker: "INTU", recommendation: "HOLD", confidence: 0.75, reasoning: "[Buffett] Wide moat, wait for 0.85x fair value.", fromWatchlist: false },
      { ticker: "INTU", recommendation: "BUY", confidence: 0.6, reasoning: "[Long-term] Cheap with a 40% FCF margin.", fromWatchlist: false },
      { ticker: "MSFT", recommendation: "SELL", confidence: 0.65, reasoning: "[Swing] RSI 73.85 is overbought.", fromWatchlist: false },
    ]);
  });

  it("keeps NONE verdicts out of the signals", async () => {
    write("NVDA-swing-trading-large-cap.md", "VERDICT: NONE | 0.9 | Very High uncertainty makes it ineligible.");
    const r = buildSignalsFromDir(dir);
    expect(r.signals).toEqual([]);
    expect(r.noSignal).toEqual(["NVDA-swing-trading-large-cap.md"]);
  });

  it("reports a missing or invalid verdict as an error without dropping the valid ones", async () => {
    write("GOOG-long-term-quality.md", "VERDICT: HOLD | 0.7 | fine");
    write("AAPL-long-term-quality.md", "a long write-up with no verdict line");
    write("AMZN-long-term-quality.md", "VERDICT: ACCUMULATE | 0.7 | unknown label");
    const r = buildSignalsFromDir(dir);
    expect(r.signals.map((s) => s.ticker)).toEqual(["GOOG"]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join("\n")).toContain("AAPL-long-term-quality.md");
    expect(r.errors.join("\n")).toContain("ACCUMULATE");
  });

  it("flags watchlist tickers from data-dump.json, even with log lines before the array", async () => {
    write("data-dump.json", 'noise line\n[\n  {"ticker":"RIVN","isWatchlist":true},\n  {"ticker":"GOOG","isWatchlist":false}\n]\n');
    write("RIVN-long-term-quality.md", "VERDICT: HOLD | 0.4 | pre-profit");
    write("GOOG-long-term-quality.md", "VERDICT: HOLD | 0.7 | fine");
    const byTicker = Object.fromEntries(buildSignalsFromDir(dir).signals.map((s) => [s.ticker, s.fromWatchlist]));
    expect(byTicker).toEqual({ RIVN: true, GOOG: false });
  });

  it("ignores files that aren't skill write-ups", async () => {
    write("signals.json", "[]");
    write("INTU-long-term-quality.log", "stderr");
    expect(buildSignalsFromDir(dir)).toEqual({ signals: [], noSignal: [], errors: [] });
  });

  it("collectEvaluationsFromDir captures NONE verdicts with quote RSI and price from data-dump.json", () => {
    write(
      "data-dump.json",
      JSON.stringify([
        { ticker: "RIVN", quote: { close: 12.34, rsi: 15.8 } },
        { ticker: "GOOG", quote: { close: 175.0, rsi: 14.87 } },
      ])
    );
    write("RIVN-swing-trading-large-cap.md", "No setup.\nVERDICT: NONE | 0.97 | Weak bounce\n");
    write("GOOG-swing-trading-large-cap.md", "Oversold.\nVERDICT: BUY | 0.85 | Oversold quality\n");
    expect(collectEvaluationsFromDir(dir)).toEqual([
      { ticker: "GOOG", skill: "swing-trading-large-cap", verdict: "BUY", rsi: 14.87, price: 175.0 },
      { ticker: "RIVN", skill: "swing-trading-large-cap", verdict: "NONE", rsi: 15.8, price: 12.34 },
    ]);
  });

  it("labels long-term-quality signals '[no thesis on file]' with Buffett research guidance when brainRoot shows no recorded thesis", () => {
    const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-signal-brain-"));
    try {
      const companiesDir = path.join(brainRoot, "financial", "brain", "investing", "public", "companies");
      fs.mkdirSync(companiesDir, { recursive: true });
      fs.writeFileSync(
        path.join(companiesDir, "AAPL.md"),
        '# AAPL\n\n## Your thesis (compiled truth)\n\n> "ecosystem moat"\n'
      );
      fs.writeFileSync(
        path.join(companiesDir, "GOOG.md"),
        "# GOOG\n\n## Your thesis (compiled truth)\n\n_No thesis recorded yet. Add one via the CLI._\n"
      );

      write("AAPL-long-term-quality.md", "VERDICT: HOLD | 0.7 | Intact ecosystem moat.");
      write("GOOG-long-term-quality.md", "VERDICT: BUY | 0.75 | Wide moat at a discount.");
      write("GOOG-buffett-value.md", "VERDICT: BUY | 0.8 | Exemplary allocator at 0.86x fair value.");
      write("MSFT-long-term-quality.md", "VERDICT: HOLD | 0.65 | Enterprise cloud durability.");
      write("GOOG-swing-trading-large-cap.md", "VERDICT: BUY | 0.8 | RSI oversold bounce.");

      const r = buildSignalsFromDir(dir, { brainRoot });
      expect(r.errors).toEqual([]);
      const byKey = Object.fromEntries(
        r.signals.map((s) => [`${s.ticker}:${s.reasoning.split(" ")[0]}`, s.reasoning])
      );

      // Covered ticker is untouched
      expect(byKey["AAPL:[Long-term]"]).toBe("[Long-term] Intact ecosystem moat.");
      // Empty-thesis and missing-file tickers on long-term-quality and buffett-value get [no thesis on file] + Buffett research prompt
      expect(byKey["GOOG:[Long-term]"]).toContain(`[Long-term] ${NO_THESIS_TAG} Wide moat at a discount.`);
      expect(byKey["GOOG:[Long-term]"]).toContain("Buffett research needed: research GOOG across the 5 Buffett owner pillars");
      expect(byKey["GOOG:[Buffett]"]).toContain(`[Buffett] ${NO_THESIS_TAG} Exemplary allocator at 0.86x fair value.`);
      expect(byKey["MSFT:[Long-term]"]).toContain(`[Long-term] ${NO_THESIS_TAG} Enterprise cloud durability.`);
      // Swing signal is never tagged for long-term thesis absence
      expect(byKey["GOOG:[Swing]"]).toBe("[Swing] RSI oversold bounce.");
    } finally {
      fs.rmSync(brainRoot, { recursive: true, force: true });
    }
  });
});

describe("filterUnchangedSignals", () => {
  let tmp: string;
  let db: Db;
  const swing = (ticker: string, recommendation: BuiltSignal["recommendation"], reasoning = "RSI stuff"): BuiltSignal => ({
    ticker,
    recommendation,
    confidence: 0.8,
    reasoning: `[Swing] ${reasoning}`,
    fromWatchlist: false,
  });

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-dedupe-"));
    db = await openTestDb();
    await db.addTicker("MSFT", "MSFT", "PUBLIC");
    await db.addTicker("RIVN", "RIVN", "PUBLIC");
  });
  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("drops a signal whose recommendation matches the last recorded one for that ticker+strategy", async () => {
    await db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Swing] overbought");
    const { changed, unchanged } = await filterUnchangedSignals(db, [swing("MSFT", "SELL")]);
    expect(changed).toEqual([]);
    expect(unchanged).toHaveLength(1);
  });

  it("keeps a signal whose recommendation differs from the last recorded one", async () => {
    await db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Swing] overbought");
    const { changed, unchanged } = await filterUnchangedSignals(db, [swing("MSFT", "HOLD")]);
    expect(changed).toHaveLength(1);
    expect(unchanged).toEqual([]);
  });

  it("keeps a signal with no prior recorded signal (fails open)", async () => {
    const { changed } = await filterUnchangedSignals(db, [swing("MSFT", "SELL")]);
    expect(changed).toHaveLength(1);
  });

  it("does not compare across strategies — a matching long-term call doesn't suppress a swing or Buffett one", async () => {
    await db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Long-term] thesis broke");
    const buffettSell: BuiltSignal = {
      ticker: "MSFT",
      recommendation: "SELL",
      confidence: 0.8,
      reasoning: "[Buffett] extreme valuation detachment",
      fromWatchlist: false,
    };
    const { changed } = await filterUnchangedSignals(db, [swing("MSFT", "SELL"), buffettSell]);
    expect(changed).toHaveLength(2);

    // Once [Buffett] SELL is recorded, an unchanged [Buffett] SELL IS suppressed
    await db.addSignal("MSFT", "2026-10-12T08:00:00.000Z", "SELL", 0.8, "[Buffett] extreme valuation detachment");
    const after = await filterUnchangedSignals(db, [buffettSell]);
    expect(after.changed).toEqual([]);
    expect(after.unchanged).toHaveLength(1);
  });

  it("filters independently per ticker", async () => {
    await db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Swing] overbought");
    const { changed, unchanged } = await filterUnchangedSignals(db, [swing("MSFT", "SELL"), swing("RIVN", "BUY")]);
    expect(changed.map((s) => s.ticker)).toEqual(["RIVN"]);
    expect(unchanged.map((s) => s.ticker)).toEqual(["MSFT"]);
  });

  it("still treats a same-recommendation signal as changed when confidence moved enough (default threshold 0.1)", async () => {
    await db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.55, "[Swing] overbought");
    const signal = { ...swing("MSFT", "SELL"), confidence: 0.8 }; // +0.25
    const { changed, unchanged } = await filterUnchangedSignals(db, [signal]);
    expect(changed).toHaveLength(1);
    expect(unchanged).toEqual([]);
  });

  it("keeps a same-recommendation signal unchanged when confidence barely moved", async () => {
    await db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.55, "[Swing] overbought");
    const signal = { ...swing("MSFT", "SELL"), confidence: 0.58 }; // +0.03, under the default 0.1 threshold
    const { changed, unchanged } = await filterUnchangedSignals(db, [signal]);
    expect(changed).toEqual([]);
    expect(unchanged).toHaveLength(1);
  });

  it("respects a custom confidenceMoveThreshold", async () => {
    await db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.55, "[Swing] overbought");
    const signal = { ...swing("MSFT", "SELL"), confidence: 0.58 }; // +0.03
    // with a tighter 0.02 threshold, even this small a move counts as changed
    const { changed, unchanged } = await filterUnchangedSignals(db, [signal], 0.02);
    expect(changed).toHaveLength(1);
    expect(unchanged).toEqual([]);
  });
});
