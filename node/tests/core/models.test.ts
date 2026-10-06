import {
  TickerSchema,
  PositionSchema,
  WatchlistSchema,
  QuoteSchema,
  SignalSchema,
} from "../../src/core/models";

describe("Models validation (Zod)", () => {
  describe("TickerSchema", () => {
    it("parses valid ticker", () => {
      const t = TickerSchema.parse({
        symbol: "NVDA",
        name: "NVIDIA",
        type: "PUBLIC",
      });
      expect(t.symbol).toBe("NVDA");
      expect(t.type).toBe("PUBLIC");
      expect(t.addedDate).toBeInstanceOf(Date);
    });

    it("accepts PRIVATE type", () => {
      const t = TickerSchema.parse({ symbol: "anthropic", name: "Anthropic", type: "PRIVATE" });
      expect(t.type).toBe("PRIVATE");
    });

    it("rejects invalid type", () => {
      expect(() =>
        TickerSchema.parse({ symbol: "X", name: "X", type: "INVALID" })
      ).toThrow();
    });
  });

  describe("PositionSchema", () => {
    it("parses valid position", () => {
      const p = PositionSchema.parse({
        ticker: "NVDA",
        shares: 100,
        costBasis: 850.0,
        entryDate: new Date(),
      });
      expect(p.shares).toBe(100);
      expect(p.costBasis).toBe(850.0);
    });

    it("rejects negative shares", () => {
      expect(() =>
        PositionSchema.parse({
          ticker: "NVDA",
          shares: -10,
          costBasis: 850,
          entryDate: new Date(),
        })
      ).toThrow();
    });

    it("rejects zero cost basis", () => {
      expect(() =>
        PositionSchema.parse({
          ticker: "NVDA",
          shares: 100,
          costBasis: 0,
          entryDate: new Date(),
        })
      ).toThrow();
    });

    it("defaults strategy to long-term", () => {
      const p = PositionSchema.parse({
        ticker: "NVDA",
        shares: 100,
        costBasis: 850.0,
        entryDate: new Date(),
      });
      expect(p.strategy).toBe("long-term");
    });

    it("accepts swing and both as strategy values", () => {
      const swing = PositionSchema.parse({
        ticker: "NVDA",
        shares: 100,
        costBasis: 850.0,
        entryDate: new Date(),
        strategy: "swing",
      });
      expect(swing.strategy).toBe("swing");

      const both = PositionSchema.parse({
        ticker: "NVDA",
        shares: 100,
        costBasis: 850.0,
        entryDate: new Date(),
        strategy: "both",
      });
      expect(both.strategy).toBe("both");
    });

    it("rejects an invalid strategy value", () => {
      expect(() =>
        PositionSchema.parse({
          ticker: "NVDA",
          shares: 100,
          costBasis: 850.0,
          entryDate: new Date(),
          strategy: "yolo",
        })
      ).toThrow();
    });
  });

  describe("WatchlistSchema", () => {
    it("parses valid watchlist item", () => {
      const w = WatchlistSchema.parse({ ticker: "TSLA", thesis: "Waiting for dip" });
      expect(w.ticker).toBe("TSLA");
      expect(w.addedDate).toBeInstanceOf(Date);
    });

    it("rejects empty thesis", () => {
      expect(() =>
        WatchlistSchema.parse({ ticker: "TSLA", thesis: "" })
      ).toThrow();
    });
  });

  describe("SignalSchema", () => {
    it("parses valid signal", () => {
      const s = SignalSchema.parse({
        ticker: "NVDA",
        recommendation: "BUY",
        confidence: 0.85,
        reasoning: "Strong fundamentals",
      });
      expect(s.recommendation).toBe("BUY");
      expect(s.confidence).toBe(0.85);
      expect(s.fromWatchlist).toBe(false);
    });

    it("rejects confidence > 1", () => {
      expect(() =>
        SignalSchema.parse({
          ticker: "NVDA",
          recommendation: "BUY",
          confidence: 1.5,
          reasoning: "test",
        })
      ).toThrow();
    });

    it("rejects invalid recommendation", () => {
      expect(() =>
        SignalSchema.parse({
          ticker: "NVDA",
          recommendation: "MAYBE",
          confidence: 0.5,
          reasoning: "test",
        })
      ).toThrow();
    });
  });
});
