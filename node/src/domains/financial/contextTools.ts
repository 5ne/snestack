import * as fs from "fs";
import { getConfig } from "../../core/config";
import { Db } from "../../core/db";
import { getLogger } from "../../core/logger";
import { isFinnhubFundamentalsFresh } from "../../core/runCheck";
import type { ContextToolMap } from "../../core/contextTools";
import { QuoteAgent } from "./agents/quoteAgent";
import { EquityAgent } from "./agents/equityAgent";
import { quoteDataFromCache, equityDataFromCache } from "./fundamentalsCache";
import { resolveTickerUniverse } from "./cliHelpers";
import { companyBrainPath, evaluateThesisCoverage } from "./thesisCoverage";
import { loadTickerDataQualityFromDb, loadUniverseDataQualityFromDb } from "./dataQuality";

const logger = getLogger("financial/contextTools");

/**
 * Safety-net freshness windows for the cache read path below. These exist
 * only to catch "ingestion never ran" or "has been broken for days" — they
 * are deliberately generous, not each strategy's ideal freshness (that's
 * what the separate data-refresh cron cadences are for). A hit inside the
 * window never calls a live provider at all; a miss/stale falls through to
 * today's live fetch-and-persist path, so a skill never silently runs on
 * nothing, and the fallback is logged so a persistently-triggering one is
 * visible rather than silently eating the cost savings this exists for.
 */
const QUOTE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MORNINGSTAR_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export { gateFacts } from "./gate";

/**
 * The financial domain's contextTools map — what the skill frontmatter's
 * `requires: [quote, fundamentals, brain]` actually resolves to. core/ never
 * imports this file directly; the harness loads it dynamically by domain name
 * via config/domains.json.
 *
 * `quote` and `fundamentals` read from the cache data-refresh populates
 * first — a fresh hit never calls Finnhub/Morningstar at all. A miss or
 * stale row falls back to a live fetch (today's old behavior), so a skill
 * still works even if data-refresh hasn't run recently, just slower.
 */
export const contextTools: ContextToolMap = {
  quote: async (subject) => {
    const ticker = subject.toUpperCase();
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    try {
      const quoteRow = await db.getQuoteIfFresh(ticker, QUOTE_MAX_AGE_MS);
      const latestFund = quoteRow ? await db.getLatestFundamentals(ticker, "finnhub") : undefined;
      const fundRow = latestFund && isFinnhubFundamentalsFresh(latestFund.fetched_at) ? latestFund : undefined;
      if (quoteRow && fundRow) {
        return quoteDataFromCache(quoteRow, fundRow);
      }

      logger.warn(
        `Cache miss/stale for ${ticker} (quote) — falling back to a live fetch. Is data-refresh running?`
      );
      // Passing db lets QuoteAgent reuse today's RSI/MA if data-dump (or an
      // earlier run-skill call today) already computed them, instead of
      // burning another Twelve Data request for the same numbers.
      return await new QuoteAgent(config.getFinnhubApiKey(), db).safeAnalyze(ticker);
    } finally {
      await db.close();
    }
  },

  fundamentals: async (subject) => {
    const ticker = subject.toUpperCase();
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    try {
      const row = await db.getFundamentalsIfFresh(ticker, "morningstar", MORNINGSTAR_MAX_AGE_MS);
      if (row) return equityDataFromCache(row);

      logger.warn(
        `Cache miss/stale for ${ticker} (fundamentals) — falling back to a live fetch. Is data-refresh running?`
      );
      return await new EquityAgent(undefined, undefined, db).safeAnalyze(ticker);
    } finally {
      await db.close();
    }
  },

  brain: async (subject) => {
    const brainRoot = getConfig().getBrainRoot();
    const file = companyBrainPath(brainRoot, subject);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  },

  "thesis-coverage": async (subject) => {
    const config = getConfig();
    const brainRoot = config.getBrainRoot();
    const trimmed = subject.trim();
    const isFullUniverse = trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "all";
    if (!isFullUniverse) {
      const explicitTickers = trimmed
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
      return evaluateThesisCoverage(brainRoot, explicitTickers);
    }

    const db = await Db.open(config.getDatabaseUrl());
    try {
      const tickers = await resolveTickerUniverse(db);
      return evaluateThesisCoverage(brainRoot, tickers);
    } finally {
      await db.close();
    }
  },

  "data-quality": async (subject) => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    try {
      const trimmed = subject.trim();
      const isFullUniverse = trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "all";
      if (isFullUniverse) {
        return await loadUniverseDataQualityFromDb(db);
      }
      return await loadTickerDataQualityFromDb(db, trimmed);
    } finally {
      await db.close();
    }
  },
};
