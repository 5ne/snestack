import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Db } from "../../src/core/db";

function tmpDb(): Db {
  const p = path.join(os.tmpdir(), `snestack-test-${Date.now()}-${Math.random()}.db`);
  return new Db(p);
}

describe("Db", () => {
  let db: Db;

  beforeEach(() => {
    db = tmpDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── Tickers ──────────────────────────────────────────────────────────────

  describe("addTicker", () => {
    it("adds a ticker successfully", () => {
      expect(db.addTicker("NVDA", "NVIDIA", "PUBLIC")).toBe(true);
    });

    it("ignores duplicate ticker", () => {
      db.addTicker("NVDA", "NVIDIA", "PUBLIC");
      expect(db.addTicker("NVDA", "NVIDIA", "PUBLIC")).toBe(true); // INSERT OR IGNORE
    });
  });

  // ── Positions ─────────────────────────────────────────────────────────────

  describe("positions", () => {
    beforeEach(() => {
      db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds a position", () => {
      expect(db.addPosition("NVDA", 100, 850.0)).toBe(true);
      const pos = db.getPosition("NVDA");
      expect(pos).toBeDefined();
      expect(pos?.shares).toBe(100);
      expect(pos?.cost_basis).toBe(850.0);
    });

    it("returns undefined for missing position", () => {
      expect(db.getPosition("AAPL")).toBeUndefined();
    });

    it("returns all positions", () => {
      db.addPosition("NVDA", 100, 850.0);
      expect(db.getAllPositions()).toHaveLength(1);
    });

    it("removes a position", () => {
      db.addPosition("NVDA", 100, 850.0);
      expect(db.removePosition("NVDA")).toBe(true);
      expect(db.getPosition("NVDA")).toBeUndefined();
    });

    it("removePosition returns false for non-existent", () => {
      expect(db.removePosition("AAPL")).toBe(false);
    });

    it("upserts position", () => {
      db.addPosition("NVDA", 100, 850.0);
      db.addPosition("NVDA", 200, 900.0);
      const pos = db.getPosition("NVDA");
      expect(pos?.shares).toBe(200);
    });

    it("defaults strategy to long-term when not specified", () => {
      db.addPosition("NVDA", 100, 850.0);
      expect(db.getPosition("NVDA")?.strategy).toBe("long-term");
    });

    it("accepts an explicit strategy", () => {
      db.addPosition("NVDA", 100, 850.0, null, "swing");
      expect(db.getPosition("NVDA")?.strategy).toBe("swing");
    });

    it("preserves existing strategy on update when not re-specified", () => {
      db.addPosition("NVDA", 100, 850.0, null, "both");
      db.addPosition("NVDA", 200, 900.0); // no strategy passed — should not reset to long-term
      expect(db.getPosition("NVDA")?.strategy).toBe("both");
    });

    it("preserves existing notes on update when not re-specified", () => {
      db.addPosition("NVDA", 100, 850.0, "AI thesis");
      db.addPosition("NVDA", 200, 900.0); // no notes passed — should not wipe them
      expect(db.getPosition("NVDA")?.notes).toBe("AI thesis");
    });

    it("updatePositionStrategy changes just the strategy", () => {
      db.addPosition("NVDA", 100, 850.0);
      expect(db.updatePositionStrategy("NVDA", "swing")).toBe(true);
      const pos = db.getPosition("NVDA");
      expect(pos?.strategy).toBe("swing");
      expect(pos?.shares).toBe(100); // untouched
    });

    it("updatePositionStrategy rejects an invalid strategy", () => {
      db.addPosition("NVDA", 100, 850.0);
      expect(db.updatePositionStrategy("NVDA", "yolo")).toBe(false);
    });

    it("updatePositionStrategy returns false for a non-existent position", () => {
      expect(db.updatePositionStrategy("AAPL", "swing")).toBe(false);
    });
  });

  // ── Watchlist ─────────────────────────────────────────────────────────────

  describe("watchlist", () => {
    beforeEach(() => {
      db.addTicker("TSLA", "Tesla", "PUBLIC");
    });

    it("adds to watchlist", () => {
      expect(db.addWatchlist("TSLA", "wait for dip")).toBe(true);
      const wl = db.getWatchlist();
      expect(wl).toHaveLength(1);
      expect(wl[0].thesis).toBe("wait for dip");
    });

    it("removes from watchlist", () => {
      db.addWatchlist("TSLA", "wait for dip");
      expect(db.removeWatchlist("TSLA")).toBe(true);
      expect(db.getWatchlist()).toHaveLength(0);
    });

    it("removeWatchlist returns false for non-existent", () => {
      expect(db.removeWatchlist("AAPL")).toBe(false);
    });
  });

  // ── Quotes ────────────────────────────────────────────────────────────────

  describe("quotes", () => {
    beforeEach(() => {
      db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds a quote", () => {
      expect(
        db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, 65, 900, 850)
      ).toBe(true);
    });

    it("gets latest quote", () => {
      db.addQuote("NVDA", "2024-01-14", 890, 900, 885, 895, 40000000);
      db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, 65, 900, 850);
      const q = db.getLatestQuote("NVDA");
      expect(q?.close).toBe(905);
      expect(q?.rsi).toBe(65);
    });

    it("returns undefined for missing quote", () => {
      expect(db.getLatestQuote("AAPL")).toBeUndefined();
    });

    it("getQuotes returns ordered by date desc", () => {
      db.addQuote("NVDA", "2024-01-13", 880, 890, 875, 885, 30000000);
      db.addQuote("NVDA", "2024-01-14", 890, 900, 885, 895, 40000000);
      db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000);
      const quotes = db.getQuotes("NVDA");
      expect(quotes[0].date).toBe("2024-01-15");
      expect(quotes[2].date).toBe("2024-01-13");
    });

    it("stores null indicators", () => {
      db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000);
      const q = db.getLatestQuote("NVDA");
      expect(q?.rsi).toBeNull();
      expect(q?.ma_50).toBeNull();
    });

    it("defaults fetched_at to now when not specified", () => {
      const before = Date.now();
      db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000);
      const q = db.getLatestQuote("NVDA");
      expect(q?.fetched_at).not.toBeNull();
      expect(Date.parse(q!.fetched_at!)).toBeGreaterThanOrEqual(before);
    });

    it("accepts an explicit fetched_at", () => {
      db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, null, null, null, "2024-01-15T09:30:00Z");
      expect(db.getLatestQuote("NVDA")?.fetched_at).toBe("2024-01-15T09:30:00Z");
    });

    describe("getQuoteIfFresh", () => {
      it("returns the row within maxAgeMs", () => {
        db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, null, null, null, new Date().toISOString());
        expect(db.getQuoteIfFresh("NVDA", 60_000)?.close).toBe(905);
      });

      it("returns undefined past maxAgeMs", () => {
        const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, null, null, null, stale);
        expect(db.getQuoteIfFresh("NVDA", 60 * 60 * 1000)).toBeUndefined();
      });

      it("returns undefined when no quote exists", () => {
        expect(db.getQuoteIfFresh("AAPL", 60_000)).toBeUndefined();
      });
    });
  });

  // ── Fundamentals ──────────────────────────────────────────────────────────

  describe("fundamentals", () => {
    beforeEach(() => {
      db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds and reads back a finnhub row", () => {
      expect(
        db.addFundamentals({
          ticker: "NVDA",
          as_of_date: "2024-01-15",
          source: "finnhub",
          pe_ratio: 65.2,
          pb_ratio: null,
          debt_to_equity: null,
          fcf: null,
          fcf_fiscal_year: null,
          fcf_yield: 0.02,
          fcf_margin: null,
          fcf_positive: 1,
          dividend_yield: null,
          earnings_growth: null,
          revenue_growth: null,
          fair_value: null,
          price_to_fair_value: null,
          economic_moat: null,
          morningstar_rating: null,
          uncertainty: null,
          capital_allocation: null,
          red_flags: null,
        })
      ).toBe(true);
      const row = db.getLatestFundamentals("NVDA", "finnhub");
      expect(row?.pe_ratio).toBe(65.2);
      expect(row?.fcf_positive).toBe(1);
    });

    it("keeps finnhub and morningstar rows separate for the same ticker+date", () => {
      const base = {
        ticker: "NVDA",
        as_of_date: "2024-01-15",
        pe_ratio: null,
        pb_ratio: null,
        debt_to_equity: null,
        fcf: null,
        fcf_fiscal_year: null,
        fcf_yield: null,
        fcf_margin: null,
        fcf_positive: null,
        dividend_yield: null,
        earnings_growth: null,
        revenue_growth: null,
        fair_value: null,
        price_to_fair_value: null,
        economic_moat: null,
        morningstar_rating: null,
        uncertainty: null,
        capital_allocation: null,
        red_flags: null,
      };
      db.addFundamentals({ ...base, source: "finnhub", pe_ratio: 65.2 });
      db.addFundamentals({ ...base, source: "morningstar", pe_ratio: 64.8 });
      expect(db.getLatestFundamentals("NVDA", "finnhub")?.pe_ratio).toBe(65.2);
      expect(db.getLatestFundamentals("NVDA", "morningstar")?.pe_ratio).toBe(64.8);
    });

    it("upserts on (ticker, as_of_date, source)", () => {
      const base = {
        ticker: "NVDA",
        as_of_date: "2024-01-15",
        source: "finnhub" as const,
        pe_ratio: 65.2,
        pb_ratio: null,
        debt_to_equity: null,
        fcf: null,
        fcf_fiscal_year: null,
        fcf_yield: null,
        fcf_margin: null,
        fcf_positive: null,
        dividend_yield: null,
        earnings_growth: null,
        revenue_growth: null,
        fair_value: null,
        price_to_fair_value: null,
        economic_moat: null,
        morningstar_rating: null,
        uncertainty: null,
        capital_allocation: null,
        red_flags: null,
      };
      db.addFundamentals(base);
      db.addFundamentals({ ...base, pe_ratio: 70.1 });
      expect(db.getLatestFundamentals("NVDA", "finnhub")?.pe_ratio).toBe(70.1);
    });

    it("getLatestFundamentals returns undefined when missing", () => {
      expect(db.getLatestFundamentals("AAPL", "finnhub")).toBeUndefined();
    });

    describe("getFundamentalsIfFresh", () => {
      const base = {
        ticker: "NVDA",
        as_of_date: "2024-01-15",
        source: "morningstar" as const,
        pe_ratio: null,
        pb_ratio: null,
        debt_to_equity: null,
        fcf: null,
        fcf_fiscal_year: null,
        fcf_yield: null,
        fcf_margin: null,
        fcf_positive: null,
        dividend_yield: null,
        earnings_growth: null,
        revenue_growth: null,
        fair_value: null,
        price_to_fair_value: null,
        economic_moat: null,
        morningstar_rating: null,
        uncertainty: null,
        capital_allocation: null,
        red_flags: null,
      };

      it("returns the row within maxAgeMs", () => {
        db.addFundamentals({ ...base, fetched_at: new Date().toISOString() });
        expect(db.getFundamentalsIfFresh("NVDA", "morningstar", 60_000)).toBeDefined();
      });

      it("returns undefined past maxAgeMs", () => {
        const stale = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
        db.addFundamentals({ ...base, fetched_at: stale });
        expect(db.getFundamentalsIfFresh("NVDA", "morningstar", 14 * 24 * 60 * 60 * 1000)).toBeUndefined();
      });

      it("returns undefined when no row exists", () => {
        expect(db.getFundamentalsIfFresh("AAPL", "morningstar", 60_000)).toBeUndefined();
      });
    });
  });

  // ── Signals ───────────────────────────────────────────────────────────────

  describe("signals", () => {
    beforeEach(() => {
      db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds a signal and returns ID", () => {
      const id = db.addSignal("NVDA", new Date().toISOString(), "BUY", 0.85, "Strong buy", false);
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("gets signal by ID", () => {
      const id = db.addSignal("NVDA", new Date().toISOString(), "HOLD", 0.5, "Neutral", false);
      const sig = db.getSignalById(id);
      expect(sig?.recommendation).toBe("HOLD");
      expect(sig?.confidence).toBe(0.5);
    });

    it("getAllSignals returns all", () => {
      db.addSignal("NVDA", new Date().toISOString(), "BUY", 0.8, "Good", false);
      db.addSignal("NVDA", new Date().toISOString(), "SELL", 0.7, "Overvalued", false);
      expect(db.getAllSignals()).toHaveLength(2);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("getAllPositions returns empty array when none", () => {
      expect(db.getAllPositions()).toEqual([]);
    });

    it("getWatchlist returns empty array when none", () => {
      expect(db.getWatchlist()).toEqual([]);
    });

    it("raw() returns the underlying db", () => {
      expect(db.raw()).toBeDefined();
    });
  });

  // ── Migrations ────────────────────────────────────────────────────────────

  describe("migrations", () => {
    it("is idempotent — reopening the same file twice does not error or duplicate columns", () => {
      const p = path.join(os.tmpdir(), `snestack-test-migrate-${Date.now()}-${Math.random()}.db`);
      const first = new Db(p);
      first.addTicker("NVDA", "NVIDIA", "PUBLIC");
      first.close();

      expect(() => {
        const second = new Db(p);
        second.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000);
        const cols = second
          .raw()
          .prepare("PRAGMA table_info(quotes)")
          .all() as unknown as Array<{ name: string }>;
        expect(cols.filter((c) => c.name === "fetched_at")).toHaveLength(1);
        second.close();
      }).not.toThrow();

      fs.unlinkSync(p);
    });
  });
});
