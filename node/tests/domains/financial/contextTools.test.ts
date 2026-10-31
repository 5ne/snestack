import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { openTestDb, shareDb } from "../../helpers/testDb";
import { Db } from "../../../src/core/db";
import { resetConfig } from "../../../src/core/config";

const quoteSafeAnalyze = jest.fn();
const equitySafeAnalyze = jest.fn();

jest.mock("../../../src/domains/financial/agents/quoteAgent", () => ({
  QuoteAgent: jest.fn().mockImplementation(() => ({ safeAnalyze: quoteSafeAnalyze })),
}));
jest.mock("../../../src/domains/financial/agents/equityAgent", () => ({
  EquityAgent: jest.fn().mockImplementation(() => ({ safeAnalyze: equitySafeAnalyze })),
}));

// Imported after the mocks above so contextTools.ts picks up the mocked agent classes.
import { contextTools } from "../../../src/domains/financial/contextTools";
import { QuoteAgent } from "../../../src/domains/financial/agents/quoteAgent";
import { EquityAgent } from "../../../src/domains/financial/agents/equityAgent";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("financial contextTools (cache-read behavior)", () => {
  let brainRoot: string;
  let shared: Db;
  let releaseShared: () => Promise<void>;

  beforeEach(async () => {
    jest.clearAllMocks();
    quoteSafeAnalyze.mockResolvedValue({ ticker: "NVDA", price: 999, timestamp: new Date() });
    equitySafeAnalyze.mockResolvedValue({ ticker: "NVDA", redFlags: [], timestamp: new Date() });

    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-contexttools-"));
    process.env.SNESTACK_BRAIN_ROOT = brainRoot;
    process.env.SNESTACK_FINNHUB_API_KEY = "fake-finnhub-key-0123456789";
    process.env.SNESTACK_DATABASE_URL = "postgres://unused-in-tests";
    resetConfig();
    shared = await openTestDb();
    releaseShared = shareDb(shared);
  });

  afterEach(async () => {
    await releaseShared();
    delete process.env.SNESTACK_DATABASE_URL;
    fs.rmSync(brainRoot, { recursive: true, force: true });
    delete process.env.SNESTACK_BRAIN_ROOT;
    delete process.env.SNESTACK_FINNHUB_API_KEY;
    resetConfig();
  });

  const emptyFundamentalsFields = {
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

  describe("quote", () => {
    it("returns the cached shape without constructing QuoteAgent when quote + finnhub fundamentals are both fresh", async () => {
      const db = shared;
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
      await db.addQuote("NVDA", new Date().toISOString().split("T")[0], 900, 910, 895, 905, 1000, 55, 890, 870, new Date().toISOString());
      await db.addFundamentals({
        ...emptyFundamentalsFields,
        ticker: "NVDA",
        as_of_date: new Date().toISOString().split("T")[0],
        source: "finnhub",
        pe_ratio: 65.2,
      });
      await db.close();

      const result = await contextTools.quote("nvda");

      expect(QuoteAgent).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ticker: "NVDA", price: 905, rsi: 55, peRatio: 65.2 });
    });

    it("falls back to a live fetch when the quote row is stale", async () => {
      const db = shared;
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
      const stale = new Date(Date.now() - 3 * DAY_MS).toISOString();
      await db.addQuote("NVDA", "2020-01-01", 900, 910, 895, 905, 1000, 55, 890, 870, stale);
      await db.addFundamentals({
        ...emptyFundamentalsFields,
        ticker: "NVDA",
        as_of_date: "2020-01-01",
        source: "finnhub",
        fetched_at: new Date().toISOString(),
      });
      await db.close();

      await contextTools.quote("nvda");

      expect(QuoteAgent).toHaveBeenCalledTimes(1);
      expect(quoteSafeAnalyze).toHaveBeenCalledWith("NVDA");
    });

    it("falls back to a live fetch when nothing is cached at all", async () => {
      await contextTools.quote("nvda");

      expect(QuoteAgent).toHaveBeenCalledTimes(1);
    });

    it("falls back when the quote row is fresh but the finnhub fundamentals row is missing", async () => {
      const db = shared;
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
      await db.addQuote("NVDA", new Date().toISOString().split("T")[0], 900, 910, 895, 905, 1000, 55, 890, 870, new Date().toISOString());
      await db.close();

      await contextTools.quote("nvda");

      expect(QuoteAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe("fundamentals", () => {
    it("returns the cached shape without constructing EquityAgent when the morningstar row is fresh", async () => {
      const db = shared;
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
      await db.addFundamentals({
        ...emptyFundamentalsFields,
        ticker: "NVDA",
        as_of_date: new Date().toISOString().split("T")[0],
        source: "morningstar",
        pe_ratio: 28.4,
        red_flags: JSON.stringify(["High P/E ratio: 28.4"]),
      });
      await db.close();

      const result = await contextTools.fundamentals("nvda");

      expect(EquityAgent).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ticker: "NVDA", peRatio: 28.4, redFlags: ["High P/E ratio: 28.4"] });
    });

    it("falls back to a live fetch when the morningstar row is older than 14 days", async () => {
      const db = shared;
      await db.addTicker("NVDA", "NVIDIA", "PUBLIC");
      await db.addFundamentals({
        ...emptyFundamentalsFields,
        ticker: "NVDA",
        as_of_date: "2020-01-01",
        source: "morningstar",
        fetched_at: new Date(Date.now() - 20 * DAY_MS).toISOString(),
      });
      await db.close();

      await contextTools.fundamentals("nvda");

      expect(EquityAgent).toHaveBeenCalledTimes(1);
      expect(equitySafeAnalyze).toHaveBeenCalledWith("NVDA");
    });

    it("falls back to a live fetch when nothing is cached at all", async () => {
      await contextTools.fundamentals("nvda");

      expect(EquityAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe("brain", () => {
    it("reads the brain file verbatim when present", async () => {
      const dir = path.join(brainRoot, "financial", "brain", "investing", "public", "companies");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "NVDA.md"), "# NVDA thesis\n\nAI platform growth.");

      const result = await contextTools.brain("nvda");
      expect(result).toBe("# NVDA thesis\n\nAI platform growth.");
    });

    it("returns null when the brain file doesn't exist", async () => {
      expect(await contextTools.brain("nvda")).toBeNull();
    });
  });
});
