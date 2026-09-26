import { CfoAgent } from "../../../../src/domains/financial/agents/cfoAgent";
import type { BatchAnalysisInput, QuoteData, StrategySignal, EquityData } from "../../../../src/core/models";

const mockQuote: QuoteData = {
  ticker: "NVDA",
  price: 905.0,
  open: 900.0,
  high: 910.0,
  low: 895.0,
  volume: 45000000,
  timestamp: new Date(),
};

const mockStrategy: StrategySignal = {
  ticker: "NVDA",
  recommendation: "BUY",
  confidence: 0.8,
  rsiSignal: "RSI 25 (oversold)",
  reasoning: "NVDA technical analysis: RSI 25 (oversold) | Golden cross: 50MA > 200MA",
  timestamp: new Date(),
};

const mockEquity: EquityData = {
  ticker: "NVDA",
  peRatio: 35.5,
  pbRatio: 15.0,
  debtToEquity: 0.3,
  fcf: 18.5e9,
  fcfYield: 0.035,
  earningsGrowth: 0.85,
  revenueGrowth: 0.55,
  redFlags: [],
  fairValue: 1050.0,
  priceToFairValue: 0.86,
  economicMoat: "Wide",
  morningstarRating: 4,
  uncertainty: "High",
  capitalAllocation: "Exemplary",
  timestamp: new Date(),
};

describe("CfoAgent.buildContext", () => {
  it("includes ticker name", () => {
    const ctx = CfoAgent.buildContext("NVDA", mockQuote, mockStrategy, mockEquity);
    expect(ctx).toContain("NVDA");
  });

  it("includes price", () => {
    const ctx = CfoAgent.buildContext("NVDA", mockQuote, mockStrategy, mockEquity);
    expect(ctx).toContain("905.00");
  });

  it("includes recommendation format footer", () => {
    const ctx = CfoAgent.buildContext("NVDA", null, null, null);
    expect(ctx).toContain("RECOMMENDATION:");
    expect(ctx).toContain("CONFIDENCE:");
    expect(ctx).toContain("REASONING:");
  });

  it("handles null data gracefully", () => {
    expect(() => CfoAgent.buildContext("NVDA", null, null, null)).not.toThrow();
  });

  it("includes red flags when present", () => {
    const equityWithFlags = { ...mockEquity, redFlags: ["High P/E", "Declining revenue"] };
    const ctx = CfoAgent.buildContext("NVDA", null, null, equityWithFlags);
    expect(ctx).toContain("RED FLAGS");
    expect(ctx).toContain("High P/E");
  });
});

describe("CfoAgent.buildBatchContext", () => {
  it("numbers each ticker", () => {
    const items: BatchAnalysisInput[] = [
      { ticker: "NVDA", quote: mockQuote },
      { ticker: "AAPL", quote: null },
    ];
    const ctx = CfoAgent.buildBatchContext(items);
    expect(ctx).toContain("1. NVDA");
    expect(ctx).toContain("2. AAPL");
  });

  it("includes JSON instruction", () => {
    const items: BatchAnalysisInput[] = [{ ticker: "NVDA" }];
    const ctx = CfoAgent.buildBatchContext(items);
    expect(ctx).toContain("JSON array");
  });
});

describe("CfoAgent.parseResponse", () => {
  it("parses valid response", () => {
    const text = `RECOMMENDATION: BUY\nCONFIDENCE: 0.85\nREASONING: Strong AI demand`;
    const result = CfoAgent.parseResponse(text);
    expect(result.recommendation).toBe("BUY");
    expect(result.confidence).toBe(0.85);
    expect(result.reasoning).toBe("Strong AI demand");
  });

  it("defaults to HOLD on invalid recommendation", () => {
    const text = `RECOMMENDATION: MAYBE\nCONFIDENCE: 0.5\nREASONING: Uncertain`;
    const result = CfoAgent.parseResponse(text);
    expect(result.recommendation).toBe("HOLD");
  });

  it("handles percentage confidence", () => {
    const text = `RECOMMENDATION: SELL\nCONFIDENCE: 75%\nREASONING: Overvalued`;
    const result = CfoAgent.parseResponse(text);
    expect(result.confidence).toBe(0.75);
  });

  it("clamps confidence to 0-1", () => {
    const text = `RECOMMENDATION: BUY\nCONFIDENCE: 1.5\nREASONING: Very bullish`;
    const result = CfoAgent.parseResponse(text);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("defaults confidence to 0.5 on parse failure", () => {
    const text = `RECOMMENDATION: BUY\nCONFIDENCE: notanumber\nREASONING: test`;
    const result = CfoAgent.parseResponse(text);
    expect(result.confidence).toBe(0.5);
  });
});

describe("CfoAgent.parseBatchResponse", () => {
  const items: BatchAnalysisInput[] = [
    { ticker: "NVDA" },
    { ticker: "AAPL" },
  ];

  it("parses valid JSON array", () => {
    const json = JSON.stringify([
      { ticker: "NVDA", recommendation: "BUY", confidence: 0.85, reasoning: "Strong AI" },
      { ticker: "AAPL", recommendation: "HOLD", confidence: 0.6, reasoning: "Fair value" },
    ]);
    const { signals, issues } = CfoAgent.parseBatchResponse(json, items);
    expect(signals).toHaveLength(2);
    expect(signals[0].ticker).toBe("NVDA");
    expect(signals[0].recommendation).toBe("BUY");
    expect(signals[1].ticker).toBe("AAPL");
    expect(issues).toEqual({});
  });

  it("strips markdown fences", () => {
    const json =
      "```json\n" +
      JSON.stringify([{ ticker: "NVDA", recommendation: "BUY", confidence: 0.8, reasoning: "test" }]) +
      "\n```";
    const { signals } = CfoAgent.parseBatchResponse(json, [{ ticker: "NVDA" }]);
    expect(signals[0].recommendation).toBe("BUY");
  });

  it("fills missing tickers with HOLD defaults", () => {
    const json = JSON.stringify([
      { ticker: "NVDA", recommendation: "BUY", confidence: 0.8, reasoning: "test" },
    ]);
    const { signals } = CfoAgent.parseBatchResponse(json, items);
    const aapl = signals.find((s) => s.ticker === "AAPL");
    expect(aapl?.recommendation).toBe("HOLD");
    expect(aapl?.confidence).toBe(0.5);
  });

  it("normalizes invalid recommendation to HOLD", () => {
    const json = JSON.stringify([
      { ticker: "NVDA", recommendation: "MAYBE", confidence: 0.5, reasoning: "test" },
    ]);
    const { signals } = CfoAgent.parseBatchResponse(json, [{ ticker: "NVDA" }]);
    expect(signals[0].recommendation).toBe("HOLD");
  });

  it("handles invalid JSON gracefully", () => {
    const { signals } = CfoAgent.parseBatchResponse("not json at all", items);
    // Should fill all items with defaults
    expect(signals).toHaveLength(2);
    signals.forEach((s) => expect(s.recommendation).toBe("HOLD"));
  });

  it("clamps confidence to [0, 1]", () => {
    const json = JSON.stringify([
      { ticker: "NVDA", recommendation: "BUY", confidence: 2.5, reasoning: "test" },
    ]);
    const { signals } = CfoAgent.parseBatchResponse(json, [{ ticker: "NVDA" }]);
    expect(signals[0].confidence).toBeLessThanOrEqual(1);
  });

  it("records an issue for a ticker missing from the parsed response", () => {
    const json = JSON.stringify([
      { ticker: "NVDA", recommendation: "BUY", confidence: 0.8, reasoning: "test" },
    ]);
    const { issues } = CfoAgent.parseBatchResponse(json, items);
    expect(issues.AAPL).toBeDefined();
    expect(issues.NVDA).toBeUndefined();
  });

  it("records an issue for every ticker when the whole response is invalid JSON", () => {
    const { issues } = CfoAgent.parseBatchResponse("not json at all", items);
    expect(Object.keys(issues).sort()).toEqual(["AAPL", "NVDA"]);
  });
});
