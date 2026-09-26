import * as os from "os";
import * as path from "path";
import { Db } from "../../../../src/core/db";
import { StrategyAgent } from "../../../../src/domains/financial/agents/strategyAgent";

function tmpDb(): Db {
  return new Db(
    path.join(os.tmpdir(), `fstack-strategy-${Date.now()}-${Math.random()}.db`)
  );
}

describe("StrategyAgent static methods", () => {
  describe("rsiSignal", () => {
    it("returns BUY 0.8 for RSI < 30 (oversold)", () => {
      expect(StrategyAgent.rsiSignal(25)).toEqual({ rec: "BUY", weight: 0.8 });
    });

    it("returns SELL 0.6 for RSI > 70 (overbought)", () => {
      expect(StrategyAgent.rsiSignal(75)).toEqual({ rec: "SELL", weight: 0.6 });
    });

    it("returns BUY 0.4 for RSI in 30-40 range", () => {
      expect(StrategyAgent.rsiSignal(35)).toEqual({ rec: "BUY", weight: 0.4 });
    });

    it("returns SELL 0.3 for RSI in 60-70 range", () => {
      expect(StrategyAgent.rsiSignal(65)).toEqual({ rec: "SELL", weight: 0.3 });
    });

    it("returns null for neutral RSI (40-60)", () => {
      expect(StrategyAgent.rsiSignal(50)).toBeNull();
    });

    it("returns null for RSI exactly 40", () => {
      expect(StrategyAgent.rsiSignal(40)).toBeNull();
    });

    it("returns null for RSI exactly 60", () => {
      expect(StrategyAgent.rsiSignal(60)).toBeNull();
    });
  });

  describe("maSignal", () => {
    it("returns BUY 0.7 in golden cross with price above MA50", () => {
      // ma50 > ma200, price > ma50
      expect(StrategyAgent.maSignal(110, 100, 90)).toEqual({ rec: "BUY", weight: 0.7 });
    });

    it("returns BUY 0.5 in golden cross with price below MA50 but above MA200", () => {
      // ma50 > ma200, ma200 < price < ma50
      expect(StrategyAgent.maSignal(95, 100, 90)).toEqual({ rec: "BUY", weight: 0.5 });
    });

    it("returns SELL 0.7 in death cross with price below MA50", () => {
      // ma50 < ma200, price < ma50
      expect(StrategyAgent.maSignal(80, 90, 100)).toEqual({ rec: "SELL", weight: 0.7 });
    });

    it("returns SELL 0.5 in death cross with price between MA50 and MA200", () => {
      // ma50 < ma200, ma50 < price < ma200
      expect(StrategyAgent.maSignal(95, 90, 100)).toEqual({ rec: "SELL", weight: 0.5 });
    });

    it("returns null when MAs are equal", () => {
      expect(StrategyAgent.maSignal(100, 100, 100)).toBeNull();
    });

    it("returns null in golden cross with price below both MAs", () => {
      // ma50 > ma200, price < ma200 (undefined territory)
      expect(StrategyAgent.maSignal(80, 100, 90)).toBeNull();
    });
  });

  describe("weightedConsensus", () => {
    it("returns HOLD for empty signals", () => {
      expect(StrategyAgent.weightedConsensus([])).toBe("HOLD");
    });

    it("returns BUY when buy weight dominates", () => {
      expect(
        StrategyAgent.weightedConsensus([
          { rec: "BUY", weight: 0.8 },
          { rec: "BUY", weight: 0.7 },
        ])
      ).toBe("BUY");
    });

    it("returns SELL when sell weight dominates", () => {
      expect(
        StrategyAgent.weightedConsensus([
          { rec: "SELL", weight: 0.6 },
          { rec: "SELL", weight: 0.7 },
        ])
      ).toBe("SELL");
    });

    it("returns HOLD when signals conflict", () => {
      expect(
        StrategyAgent.weightedConsensus([
          { rec: "BUY", weight: 0.5 },
          { rec: "SELL", weight: 0.5 },
        ])
      ).toBe("HOLD");
    });

    it("returns SELL when sell weight dominates even at low absolute values", () => {
      // BUY 0.2, SELL 0.3 → sellRatio = 0.6 > 0.4 → SELL
      expect(
        StrategyAgent.weightedConsensus([
          { rec: "BUY", weight: 0.2 },
          { rec: "SELL", weight: 0.3 },
        ])
      ).toBe("SELL");
    });
  });
});

describe("StrategyAgent.analyze", () => {
  let db: Db;
  let agent: StrategyAgent;

  beforeEach(() => {
    db = tmpDb();
    agent = new StrategyAgent(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns HOLD with 0 confidence when no quote data", async () => {
    const signal = await agent.analyze("NVDA");
    expect(signal.recommendation).toBe("HOLD");
    expect(signal.confidence).toBe(0);
    expect(signal.reasoning).toMatch(/No quote data/);
  });

  it("generates BUY signal for oversold RSI", async () => {
    db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    db.addQuote("NVDA", "2024-01-15", 100, 105, 98, 102, 1000000, 25, null, null);
    const signal = await agent.analyze("NVDA");
    expect(signal.recommendation).toBe("BUY");
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it("generates SELL signal for overbought RSI", async () => {
    db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    db.addQuote("NVDA", "2024-01-15", 100, 105, 98, 102, 1000000, 75, null, null);
    const signal = await agent.analyze("NVDA");
    expect(signal.recommendation).toBe("SELL");
  });

  it("generates BUY for golden cross with price above MA50", async () => {
    db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    // RSI neutral (50), ma50 > ma200, price > ma50 → BUY
    db.addQuote("NVDA", "2024-01-15", 110, 115, 108, 112, 1000000, 50, 100, 90);
    const signal = await agent.analyze("NVDA");
    expect(signal.recommendation).toBe("BUY");
  });

  it("returns ticker name in signal", async () => {
    db.addTicker("AAPL", "Apple", "PUBLIC");
    db.addQuote("AAPL", "2024-01-15", 100, 105, 98, 102, 1000000, 50, null, null);
    const signal = await agent.analyze("AAPL");
    expect(signal.ticker).toBe("AAPL");
  });

  it("batchAnalyze processes multiple tickers", async () => {
    db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    db.addTicker("AAPL", "Apple", "PUBLIC");
    const results = await agent.batchAnalyze(["NVDA", "AAPL"]);
    expect(Object.keys(results)).toHaveLength(2);
  });
});
