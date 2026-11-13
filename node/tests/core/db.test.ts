import { Db } from "../../src/core/db";
import { openTestDb } from "../helpers/testDb";

describe("Db", () => {
  let db: Db;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  // ── Tickers ──────────────────────────────────────────────────────────────

  describe("addTicker", () => {
    it("adds a ticker successfully", async () => {
      expect(await db.addTicker("NVDA", "NVIDIA", "PUBLIC")).toBe(true);
    });

    it("ignores duplicate ticker", async () => {
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
      expect(await db.addTicker("NVDA", "NVIDIA", "PUBLIC")).toBe(true); // INSERT OR IGNORE
    });
  });

  // ── Positions ─────────────────────────────────────────────────────────────

  describe("positions", () => {
    beforeEach(async () => {
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds a position", async () => {
      expect(await db.addPosition("NVDA", 100, 850.0)).toBe(true);
      const pos = await db.getPosition("NVDA");
      expect(pos).toBeDefined();
      expect(pos?.shares).toBe(100);
      expect(pos?.cost_basis).toBe(850.0);
    });

    it("returns undefined for missing position", async () => {
      expect(await db.getPosition("AAPL")).toBeUndefined();
    });

    it("returns all positions", async () => {
      await db.addPosition("NVDA", 100, 850.0);
      expect(await db.getAllPositions()).toHaveLength(1);
    });

    it("removes a position", async () => {
      await db.addPosition("NVDA", 100, 850.0);
      expect(await db.removePosition("NVDA")).toBe(true);
      expect(await db.getPosition("NVDA")).toBeUndefined();
    });

    it("removePosition returns false for non-existent", async () => {
      expect(await db.removePosition("AAPL")).toBe(false);
    });

    it("upserts position", async () => {
      await db.addPosition("NVDA", 100, 850.0);
      await db.addPosition("NVDA", 200, 900.0);
      const pos = await db.getPosition("NVDA");
      expect(pos?.shares).toBe(200);
    });

    it("defaults strategy to long-term when not specified", async () => {
      await db.addPosition("NVDA", 100, 850.0);
      expect((await db.getPosition("NVDA"))?.strategy).toBe("long-term");
    });

    it("accepts an explicit strategy", async () => {
      await db.addPosition("NVDA", 100, 850.0, null, "swing");
      expect((await db.getPosition("NVDA"))?.strategy).toBe("swing");
    });

    it("preserves existing strategy on update when not re-specified", async () => {
      await db.addPosition("NVDA", 100, 850.0, null, "both");
      await db.addPosition("NVDA", 200, 900.0); // no strategy passed — should not reset to long-term
      expect((await db.getPosition("NVDA"))?.strategy).toBe("both");
    });

    it("preserves existing notes on update when not re-specified", async () => {
      await db.addPosition("NVDA", 100, 850.0, "AI thesis");
      await db.addPosition("NVDA", 200, 900.0); // no notes passed — should not wipe them
      expect((await db.getPosition("NVDA"))?.notes).toBe("AI thesis");
    });

    it("updatePositionStrategy changes just the strategy", async () => {
      await db.addPosition("NVDA", 100, 850.0);
      expect(await db.updatePositionStrategy("NVDA", "swing")).toBe(true);
      const pos = await db.getPosition("NVDA");
      expect(pos?.strategy).toBe("swing");
      expect(pos?.shares).toBe(100); // untouched
    });

    it("updatePositionStrategy rejects an invalid strategy", async () => {
      await db.addPosition("NVDA", 100, 850.0);
      expect(await db.updatePositionStrategy("NVDA", "yolo")).toBe(false);
    });

    it("updatePositionStrategy returns false for a non-existent position", async () => {
      expect(await db.updatePositionStrategy("AAPL", "swing")).toBe(false);
    });
  });

  // ── Watchlist ─────────────────────────────────────────────────────────────

  describe("watchlist", () => {
    beforeEach(async () => {
      await db.addTicker("TSLA", "Tesla", "PUBLIC");
    });

    it("adds to watchlist", async () => {
      expect(await db.addWatchlist("TSLA", "wait for dip")).toBe(true);
      const wl = await db.getWatchlist();
      expect(wl).toHaveLength(1);
      expect(wl[0].thesis).toBe("wait for dip");
    });

    it("removes from watchlist", async () => {
      await db.addWatchlist("TSLA", "wait for dip");
      expect(await db.removeWatchlist("TSLA")).toBe(true);
      expect(await db.getWatchlist()).toHaveLength(0);
    });

    it("removeWatchlist returns false for non-existent", async () => {
      expect(await db.removeWatchlist("AAPL")).toBe(false);
    });
  });

  // ── Quotes ────────────────────────────────────────────────────────────────

  describe("quotes", () => {
    beforeEach(async () => {
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds a quote", async () => {
      expect(
        await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, 65, 900, 850)
      ).toBe(true);
    });

    it("gets latest quote", async () => {
      await db.addQuote("NVDA", "2024-01-14", 890, 900, 885, 895, 40000000);
      await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, 65, 900, 850);
      const q = await db.getLatestQuote("NVDA");
      expect(q?.close).toBe(905);
      expect(q?.rsi).toBe(65);
    });

    it("returns undefined for missing quote", async () => {
      expect(await db.getLatestQuote("AAPL")).toBeUndefined();
    });

    it("getQuotes returns ordered by date desc", async () => {
      await db.addQuote("NVDA", "2024-01-13", 880, 890, 875, 885, 30000000);
      await db.addQuote("NVDA", "2024-01-14", 890, 900, 885, 895, 40000000);
      await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000);
      const quotes = await db.getQuotes("NVDA");
      expect(quotes[0].date).toBe("2024-01-15");
      expect(quotes[2].date).toBe("2024-01-13");
    });

    it("stores null indicators", async () => {
      await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000);
      const q = await db.getLatestQuote("NVDA");
      expect(q?.rsi).toBeNull();
      expect(q?.ma_50).toBeNull();
    });

    it("defaults fetched_at to now when not specified", async () => {
      const before = Date.now();
      await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000);
      const q = await db.getLatestQuote("NVDA");
      expect(q?.fetched_at).not.toBeNull();
      expect(Date.parse(q!.fetched_at!)).toBeGreaterThanOrEqual(before);
    });

    it("accepts an explicit fetched_at", async () => {
      await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, null, null, null, "2024-01-15T09:30:00Z");
      expect((await db.getLatestQuote("NVDA"))?.fetched_at).toBe("2024-01-15T09:30:00Z");
    });

    describe("getQuoteIfFresh", () => {
      it("returns the row within maxAgeMs", async () => {
        await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, null, null, null, new Date().toISOString());
        expect((await db.getQuoteIfFresh("NVDA", 60_000))?.close).toBe(905);
      });

      it("returns undefined past maxAgeMs", async () => {
        const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        await db.addQuote("NVDA", "2024-01-15", 900, 910, 895, 905, 45000000, null, null, null, stale);
        expect(await db.getQuoteIfFresh("NVDA", 60 * 60 * 1000)).toBeUndefined();
      });

      it("returns undefined when no quote exists", async () => {
        expect(await db.getQuoteIfFresh("AAPL", 60_000)).toBeUndefined();
      });
    });
  });

  // ── Fundamentals ──────────────────────────────────────────────────────────

  describe("fundamentals", () => {
    beforeEach(async () => {
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds and reads back a finnhub row", async () => {
      expect(
        await db.addFundamentals({
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
      const row = await db.getLatestFundamentals("NVDA", "finnhub");
      expect(row?.pe_ratio).toBe(65.2);
      expect(row?.fcf_positive).toBe(1);
    });

    it("keeps finnhub and morningstar rows separate for the same ticker+date", async () => {
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
      await db.addFundamentals({ ...base, source: "finnhub", pe_ratio: 65.2 });
      await db.addFundamentals({ ...base, source: "morningstar", pe_ratio: 64.8 });
      expect((await db.getLatestFundamentals("NVDA", "finnhub"))?.pe_ratio).toBe(65.2);
      expect((await db.getLatestFundamentals("NVDA", "morningstar"))?.pe_ratio).toBe(64.8);
    });

    it("upserts on (ticker, as_of_date, source)", async () => {
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
      await db.addFundamentals(base);
      await db.addFundamentals({ ...base, pe_ratio: 70.1 });
      expect((await db.getLatestFundamentals("NVDA", "finnhub"))?.pe_ratio).toBe(70.1);
    });

    it("getLatestFundamentals returns undefined when missing", async () => {
      expect(await db.getLatestFundamentals("AAPL", "finnhub")).toBeUndefined();
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

      it("returns the row within maxAgeMs", async () => {
        await db.addFundamentals({ ...base, fetched_at: new Date().toISOString() });
        expect(await db.getFundamentalsIfFresh("NVDA", "morningstar", 60_000)).toBeDefined();
      });

      it("returns undefined past maxAgeMs", async () => {
        const stale = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
        await db.addFundamentals({ ...base, fetched_at: stale });
        expect(await db.getFundamentalsIfFresh("NVDA", "morningstar", 14 * 24 * 60 * 60 * 1000)).toBeUndefined();
      });

      it("returns undefined when no row exists", async () => {
        expect(await db.getFundamentalsIfFresh("AAPL", "morningstar", 60_000)).toBeUndefined();
      });
    });
  });

  // ── Signals ───────────────────────────────────────────────────────────────

  describe("signals", () => {
    beforeEach(async () => {
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("adds a signal and returns ID", async () => {
      const id = await db.addSignal("NVDA", new Date().toISOString(), "BUY", 0.85, "Strong buy", false);
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("gets signal by ID", async () => {
      const id = await db.addSignal("NVDA", new Date().toISOString(), "HOLD", 0.5, "Neutral", false);
      const sig = await db.getSignalById(id);
      expect(sig?.recommendation).toBe("HOLD");
      expect(sig?.confidence).toBe(0.5);
    });

    it("getAllSignals returns all", async () => {
      await db.addSignal("NVDA", new Date().toISOString(), "BUY", 0.8, "Good", false);
      await db.addSignal("NVDA", new Date().toISOString(), "SELL", 0.7, "Overvalued", false);
      expect(await db.getAllSignals()).toHaveLength(2);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("getAllPositions returns empty array when none", async () => {
      expect(await db.getAllPositions()).toEqual([]);
    });

    it("getWatchlist returns empty array when none", async () => {
      expect(await db.getWatchlist()).toEqual([]);
    });
  });

  // ── Opening ───────────────────────────────────────────────────────────────

  describe("open", () => {
    it("creates its schema idempotently (every CREATE is IF NOT EXISTS, so re-opening is safe)", async () => {
      // pg-mem can't re-run CREATE TABLE IF NOT EXISTS over existing tables, so assert on the SQL sent instead.
      const sent: string[] = [];
      const pool = {
        query: jest.fn(async (text: string) => {
          sent.push(text);
          return { rows: [], rowCount: 0 };
        }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      await Db.open(undefined, { pool, enableRls: false });
      const creates = sent.join("\n").match(/CREATE (TABLE|INDEX)[^(]*/g) ?? [];
      expect(creates.length).toBeGreaterThanOrEqual(10);
      for (const c of creates) expect(c).toContain("IF NOT EXISTS");
    });

    it("enables row level security on every table for real connections", async () => {
      const sent: string[] = [];
      const pool = {
        query: jest.fn(async (text: string) => {
          sent.push(text);
          return { rows: [], rowCount: 0 };
        }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      await Db.open(undefined, { pool, enableRls: true });
      for (const t of ["tickers", "positions", "watchlist", "quotes", "fundamentals", "signals", "gate_runs"]) {
        expect(sent).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      }
    });

    it("fails fast with a DatabaseError (and no connection string in the message) when the database is unreachable", async () => {
      const pool = {
        query: jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED postgres://snestack:hunter2@db.example.supabase.co:5432/postgres")),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const err = await Db.open(undefined, { pool }).catch((e) => e);
      expect(err.name).toBe("DatabaseError");
      expect(err.message).toContain("Failed to open database");
      expect(err.message).not.toContain("hunter2");
      expect(pool.end).toHaveBeenCalled();
    });

    it("requires SNESTACK_DATABASE_URL when no pool is injected", async () => {
      await expect(Db.open(undefined)).rejects.toThrow(/SNESTACK_DATABASE_URL/);
    });

    it("retries transient EMAXCONNSESSION errors on open and succeeds", async () => {
      let calls = 0;
      const pool = {
        query: jest.fn(async () => {
          calls++;
          if (calls <= 2) {
            const err = new Error("max clients reached in session mode - max clients are limited to pool_size: 15") as Error & { code?: string };
            err.code = "EMAXCONNSESSION";
            throw err;
          }
          return { rows: [], rowCount: 0 };
        }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const db = await Db.open(undefined, { pool, enableRls: false, retryDelaysMs: [1, 1] });
      expect(db).toBeInstanceOf(Db);
      expect(calls).toBe(4); // 2 failed SELECT 1 + 1 succeeded SELECT 1 + 1 SCHEMA
      expect(pool.end).not.toHaveBeenCalled();
    });

    it("fails with DatabaseError after exhausting EMAXCONNSESSION retries", async () => {
      const pool = {
        query: jest.fn(async () => {
          const err = new Error("(EMAXCONNSESSION) max clients reached in session mode") as Error & { code?: string };
          err.code = "EMAXCONNSESSION";
          throw err;
        }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const err = await Db.open(undefined, { pool, enableRls: false, retryDelaysMs: [1, 1] }).catch((e) => e);
      expect(err.name).toBe("DatabaseError");
      expect(err.message).toContain("EMAXCONNSESSION");
      expect(pool.query).toHaveBeenCalledTimes(3);
      expect(pool.end).toHaveBeenCalledTimes(1);
    });
  });

  // ── Gate runs ─────────────────────────────────────────────────────────────

  describe("gate_runs", () => {
    beforeEach(async () => {
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    });

    it("records and returns the latest gate run (including NONE verdicts)", async () => {
      expect(await db.getLastGateRun("NVDA", "swing-trading-large-cap")).toBeUndefined();
      expect(
        await db.recordGateRun({
          ticker: "NVDA",
          skill: "swing-trading-large-cap",
          runAt: "2026-11-10T15:00:00.000Z",
          verdict: "NONE",
          rsi: 26.98,
          price: 140.5,
        })
      ).toBe(true);
      expect(
        await db.recordGateRun({
          ticker: "NVDA",
          skill: "swing-trading-large-cap",
          runAt: "2026-11-10T16:00:00.000Z",
          verdict: "NONE",
          rsi: 27.1,
          price: 141.0,
        })
      ).toBe(true);
      const latest = await db.getLastGateRun("NVDA", "swing-trading-large-cap");
      expect(latest).toMatchObject({
        ticker: "NVDA",
        skill: "swing-trading-large-cap",
        run_at: "2026-11-10T16:00:00.000Z",
        verdict: "NONE",
        rsi: 27.1,
        price: 141.0,
      });
    });
  });
});
