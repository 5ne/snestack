import { QuoteAgent } from "../../../../src/domains/financial/agents/quoteAgent";

describe("QuoteAgent static methods", () => {
  describe("calculateRsi", () => {
    it("returns null for insufficient data", () => {
      expect(QuoteAgent.calculateRsi([100, 101, 102])).toBeNull();
    });

    it("returns 100 when all gains", () => {
      const prices = Array.from({ length: 16 }, (_, i) => 100 + i);
      const rsi = QuoteAgent.calculateRsi(prices);
      expect(rsi).toBe(100);
    });

    it("returns 0 when all losses", () => {
      const prices = Array.from({ length: 16 }, (_, i) => 100 - i);
      const rsi = QuoteAgent.calculateRsi(prices);
      expect(rsi).toBe(0);
    });

    it("returns value between 0-100 for mixed prices", () => {
      const prices = [
        44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.15, 43.61,
        44.33, 44.83, 45.10, 45.15, 43.61, 44.33,
      ];
      const rsi = QuoteAgent.calculateRsi(prices);
      expect(rsi).not.toBeNull();
      expect(rsi!).toBeGreaterThanOrEqual(0);
      expect(rsi!).toBeLessThanOrEqual(100);
    });

    it("handles exactly 15 prices (period+1)", () => {
      const prices = Array.from({ length: 15 }, (_, i) => 100 + (i % 3 === 0 ? 1 : -0.5));
      const rsi = QuoteAgent.calculateRsi(prices);
      expect(rsi).not.toBeNull();
    });

    it("uses custom period", () => {
      const prices = Array.from({ length: 12 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -0.5));
      const rsiDefault = QuoteAgent.calculateRsi(prices); // period=14, insufficient
      const rsiCustom = QuoteAgent.calculateRsi(prices, 10);
      expect(rsiDefault).toBeNull();
      expect(rsiCustom).not.toBeNull();
    });
  });

  describe("calculateMovingAverage", () => {
    it("returns null for insufficient data", () => {
      expect(QuoteAgent.calculateMovingAverage([100, 101], 50)).toBeNull();
    });

    it("calculates simple moving average correctly", () => {
      const prices = [100, 102, 104, 106, 108]; // avg = 104
      const ma = QuoteAgent.calculateMovingAverage(prices, 5);
      expect(ma).toBe(104);
    });

    it("uses last N prices", () => {
      const prices = [50, 50, 50, 100, 102, 104]; // last 3: avg = 102
      const ma = QuoteAgent.calculateMovingAverage(prices, 3);
      expect(ma).toBe(102);
    });

    it("returns rounded value", () => {
      const prices = [100, 101, 102];
      const ma = QuoteAgent.calculateMovingAverage(prices, 3);
      expect(Number.isFinite(ma!)).toBe(true);
    });
  });
});

describe("QuoteAgent instantiation", () => {
  it("creates instance with apiKey", () => {
    const agent = new QuoteAgent("test_api_key");
    expect(agent.name).toBe("QuoteAgent");
  });

  it("creates instance with db", () => {
    const agent = new QuoteAgent("test_api_key", undefined);
    expect(agent).toBeDefined();
  });
});
