import { QuoteAgent } from "../../../../src/domains/financial/agents/quoteAgent";
import type { QuoteProvider } from "../../../../src/domains/financial/providers/types";
import type { Db, QuoteRow } from "../../../../src/core/db";

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

describe("QuoteAgent.analyze — cached technicals", () => {
  function makeProvider(): QuoteProvider {
    return {
      getQuote: jest.fn().mockResolvedValue({ price: 100, open: 99, high: 101, low: 98, volume: 1000 }),
      getHistoricalCloses: jest.fn().mockResolvedValue(Array.from({ length: 250 }, (_, i) => 100 + i * 0.1)),
      getFundamentals: jest.fn().mockResolvedValue(null),
    };
  }

  function makeDb(cachedRow: QuoteRow | undefined): Db {
    return {
      getLatestQuote: jest.fn().mockReturnValue(cachedRow),
      addQuote: jest.fn(),
    } as unknown as Db;
  }

  it("reuses today's cached RSI/MA and skips the historical-closes fetch", async () => {
    const today = new Date().toISOString().split("T")[0];
    const provider = makeProvider();
    const db = makeDb({
      ticker: "NVDA",
      date: today,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      rsi: 42,
      ma_50: 200,
      ma_200: 190,
      fetched_at: null,
    });

    const result = await new QuoteAgent("key", db, provider).analyze("NVDA");

    expect(result?.rsi).toBe(42);
    expect(result?.ma50).toBe(200);
    expect(result?.ma200).toBe(190);
    expect(provider.getHistoricalCloses).not.toHaveBeenCalled();
    expect(db.addQuote).not.toHaveBeenCalled();
  });

  it("fetches fresh when the cached row is from a prior day", async () => {
    const provider = makeProvider();
    const db = makeDb({
      ticker: "NVDA",
      date: "2020-01-01",
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      rsi: 42,
      ma_50: 200,
      ma_200: 190,
      fetched_at: null,
    });

    await new QuoteAgent("key", db, provider).analyze("NVDA");

    expect(provider.getHistoricalCloses).toHaveBeenCalledWith("NVDA", 250);
    expect(db.addQuote).toHaveBeenCalled();
  });

  it("fetches fresh when there is no cached row at all", async () => {
    const provider = makeProvider();
    const db = makeDb(undefined);

    await new QuoteAgent("key", db, provider).analyze("NVDA");

    expect(provider.getHistoricalCloses).toHaveBeenCalled();
  });
});

describe("QuoteAgent.analyze persists fundamentals", () => {
  function makeProviderWithFundamentals(): QuoteProvider {
    return {
      getQuote: jest.fn().mockResolvedValue({ price: 100, open: 99, high: 101, low: 98, volume: 1000 }),
      getHistoricalCloses: jest.fn().mockResolvedValue(Array.from({ length: 250 }, (_, i) => 100 + i * 0.1)),
      getFundamentals: jest.fn().mockResolvedValue({
        peRatio: 65.2,
        pbRatio: 30.1,
        debtToEquity: 0.4,
        fcfYield: 0.02,
        fcfMargin: 0.3,
        fcfPositive: true,
        dividendYield: 0.001,
        earningsGrowth: 0.5,
        revenueGrowth: 0.3,
      }),
    };
  }

  function makeDb(cachedRow: QuoteRow | undefined): Db {
    return {
      getLatestQuote: jest.fn().mockReturnValue(cachedRow),
      addQuote: jest.fn(),
      addFundamentals: jest.fn(),
    } as unknown as Db;
  }

  it("persists fundamentals as source 'finnhub' on a cache-miss (fresh technicals) call", async () => {
    const provider = makeProviderWithFundamentals();
    const db = makeDb(undefined);

    await new QuoteAgent("key", db, provider).analyze("NVDA");

    expect(db.addFundamentals).toHaveBeenCalledTimes(1);
    const row = (db.addFundamentals as jest.Mock).mock.calls[0][0];
    expect(row.ticker).toBe("NVDA");
    expect(row.source).toBe("finnhub");
    expect(row.pe_ratio).toBe(65.2);
    expect(row.fcf_positive).toBe(1);
  });

  it("still persists fundamentals even on a same-day technicals cache hit", async () => {
    const today = new Date().toISOString().split("T")[0];
    const provider = makeProviderWithFundamentals();
    const db = makeDb({
      ticker: "NVDA",
      date: today,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      rsi: 42,
      ma_50: 200,
      ma_200: 190,
      fetched_at: null,
    });

    await new QuoteAgent("key", db, provider).analyze("NVDA");

    expect(provider.getHistoricalCloses).not.toHaveBeenCalled(); // technicals cache hit
    expect(db.addFundamentals).toHaveBeenCalledTimes(1); // fundamentals persisted anyway
  });

  it("does not call db.addFundamentals when fundamentals are unavailable", async () => {
    const provider: QuoteProvider = {
      getQuote: jest.fn().mockResolvedValue({ price: 100, open: 99, high: 101, low: 98, volume: 1000 }),
      getHistoricalCloses: jest.fn().mockResolvedValue(null),
      getFundamentals: jest.fn().mockResolvedValue(null),
    };
    const db = makeDb(undefined);

    await new QuoteAgent("key", db, provider).analyze("NVDA");

    expect(db.addFundamentals).not.toHaveBeenCalled();
  });
});
