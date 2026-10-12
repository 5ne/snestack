import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Db } from "../../../../src/core/db";
import { buildSignalsFromDir, filterUnchangedSignals, type BuiltSignal } from "../../../../src/domains/financial/tools/signalBuilder";

describe("buildSignalsFromDir", () => {
  let dir: string;
  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-signals-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("builds signals with the skill prefix, confidence and reasoning", () => {
    write("INTU-long-term-quality.md", "text\nVERDICT: BUY | 0.6 | Cheap with a 40% FCF margin.\n");
    write("MSFT-swing-trading-large-cap.md", "text\nVERDICT: SELL | 0.65 | RSI 73.85 is overbought.\n");
    const r = buildSignalsFromDir(dir);
    expect(r.errors).toEqual([]);
    expect(r.signals).toEqual([
      { ticker: "INTU", recommendation: "BUY", confidence: 0.6, reasoning: "[Long-term] Cheap with a 40% FCF margin.", fromWatchlist: false },
      { ticker: "MSFT", recommendation: "SELL", confidence: 0.65, reasoning: "[Swing] RSI 73.85 is overbought.", fromWatchlist: false },
    ]);
  });

  it("keeps NONE verdicts out of the signals", () => {
    write("NVDA-swing-trading-large-cap.md", "VERDICT: NONE | 0.9 | Very High uncertainty makes it ineligible.");
    const r = buildSignalsFromDir(dir);
    expect(r.signals).toEqual([]);
    expect(r.noSignal).toEqual(["NVDA-swing-trading-large-cap.md"]);
  });

  it("reports a missing or invalid verdict as an error without dropping the valid ones", () => {
    write("GOOG-long-term-quality.md", "VERDICT: HOLD | 0.7 | fine");
    write("AAPL-long-term-quality.md", "a long write-up with no verdict line");
    write("AMZN-long-term-quality.md", "VERDICT: ACCUMULATE | 0.7 | unknown label");
    const r = buildSignalsFromDir(dir);
    expect(r.signals.map((s) => s.ticker)).toEqual(["GOOG"]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join("\n")).toContain("AAPL-long-term-quality.md");
    expect(r.errors.join("\n")).toContain("ACCUMULATE");
  });

  it("flags watchlist tickers from data-dump.json, even with log lines before the array", () => {
    write("data-dump.json", 'noise line\n[\n  {"ticker":"RIVN","isWatchlist":true},\n  {"ticker":"GOOG","isWatchlist":false}\n]\n');
    write("RIVN-long-term-quality.md", "VERDICT: HOLD | 0.4 | pre-profit");
    write("GOOG-long-term-quality.md", "VERDICT: HOLD | 0.7 | fine");
    const byTicker = Object.fromEntries(buildSignalsFromDir(dir).signals.map((s) => [s.ticker, s.fromWatchlist]));
    expect(byTicker).toEqual({ RIVN: true, GOOG: false });
  });

  it("ignores files that aren't skill write-ups", () => {
    write("signals.json", "[]");
    write("INTU-long-term-quality.log", "stderr");
    expect(buildSignalsFromDir(dir)).toEqual({ signals: [], noSignal: [], errors: [] });
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

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-dedupe-"));
    db = new Db(path.join(tmp, "test.db"));
    db.addTicker("MSFT", "MSFT", "PUBLIC");
    db.addTicker("RIVN", "RIVN", "PUBLIC");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("drops a signal whose recommendation matches the last recorded one for that ticker+strategy", () => {
    db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Swing] overbought");
    const { changed, unchanged } = filterUnchangedSignals(db, [swing("MSFT", "SELL")]);
    expect(changed).toEqual([]);
    expect(unchanged).toHaveLength(1);
  });

  it("keeps a signal whose recommendation differs from the last recorded one", () => {
    db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Swing] overbought");
    const { changed, unchanged } = filterUnchangedSignals(db, [swing("MSFT", "HOLD")]);
    expect(changed).toHaveLength(1);
    expect(unchanged).toEqual([]);
  });

  it("keeps a signal with no prior recorded signal (fails open)", () => {
    const { changed } = filterUnchangedSignals(db, [swing("MSFT", "SELL")]);
    expect(changed).toHaveLength(1);
  });

  it("does not compare across strategies — a matching long-term call doesn't suppress a swing one", () => {
    db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Long-term] thesis broke");
    const { changed } = filterUnchangedSignals(db, [swing("MSFT", "SELL")]);
    expect(changed).toHaveLength(1);
  });

  it("filters independently per ticker", () => {
    db.addSignal("MSFT", "2026-10-12T07:00:00.000Z", "SELL", 0.8, "[Swing] overbought");
    const { changed, unchanged } = filterUnchangedSignals(db, [swing("MSFT", "SELL"), swing("RIVN", "BUY")]);
    expect(changed.map((s) => s.ticker)).toEqual(["RIVN"]);
    expect(unchanged.map((s) => s.ticker)).toEqual(["MSFT"]);
  });
});
