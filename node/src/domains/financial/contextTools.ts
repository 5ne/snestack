import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../../core/config";
import { Db } from "../../core/db";
import { getLogger } from "../../core/logger";
import type { ContextToolMap } from "../../core/contextTools";
import { gatherReflectionDigest, runCheckFindingsSource, runSummariesSource, existingFeatureRequestsSource } from "../../core/reflect";
import { QuoteAgent } from "./agents/quoteAgent";
import { EquityAgent } from "./agents/equityAgent";
import { quoteDataFromCache, equityDataFromCache } from "./fundamentalsCache";
import { resolveTickerUniverse } from "./cliHelpers";
import { financialRunExpectations, financialRunRoots } from "./runExpectations";

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
const FINNHUB_FUNDAMENTALS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MORNINGSTAR_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** `improve-self`'s lookback window — matches its gate's `maxAgeDays` (roughly weekly). */
const REFLECT_LOOKBACK_DAYS = 7;

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
    const db = new Db(config.getDatabasePath());
    try {
      const quoteRow = db.getQuoteIfFresh(ticker, QUOTE_MAX_AGE_MS);
      const fundRow = quoteRow
        ? db.getFundamentalsIfFresh(ticker, "finnhub", FINNHUB_FUNDAMENTALS_MAX_AGE_MS)
        : undefined;
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
      db.close();
    }
  },

  fundamentals: async (subject) => {
    const ticker = subject.toUpperCase();
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    try {
      const row = db.getFundamentalsIfFresh(ticker, "morningstar", MORNINGSTAR_MAX_AGE_MS);
      if (row) return equityDataFromCache(row);

      logger.warn(
        `Cache miss/stale for ${ticker} (fundamentals) — falling back to a live fetch. Is data-refresh running?`
      );
      return await new EquityAgent(undefined, undefined, db).safeAnalyze(ticker);
    } finally {
      db.close();
    }
  },

  brain: async (subject) => {
    const brainRoot = getConfig().getBrainRoot();
    const file = path.join(
      brainRoot,
      "financial",
      "brain",
      "investing",
      "public",
      "companies",
      `${subject.toUpperCase()}.md`
    );
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  },

  /**
   * `improve-self`'s only required context: recent automation health, recent
   * run summaries, and every existing feature-request proposal (so it doesn't
   * duplicate one). Domain-level, not per-ticker — the subject passed in is
   * ignored.
   */
  reflectionDigest: async () => {
    const config = getConfig();
    const brainRoot = config.getBrainRoot();
    const db = new Db(config.getDatabasePath());
    try {
      const tickers = resolveTickerUniverse(db);
      const ageMs = (fetchedAt: string | null): number | null => (fetchedAt ? Date.now() - Date.parse(fetchedAt) : null);
      const sources = [
        runCheckFindingsSource(financialRunExpectations(brainRoot), {
          tickers,
          getLatestQuoteAge: (ticker) => ageMs(db.getLatestQuote(ticker)?.fetched_at ?? null),
          getLatestFundamentalsAge: (ticker, source) => ageMs(db.getLatestFundamentals(ticker, source)?.fetched_at ?? null),
        }),
        runSummariesSource(financialRunRoots(brainRoot)),
        existingFeatureRequestsSource(),
      ];
      return gatherReflectionDigest(sources, {
        domain: "financial",
        brainRoot,
        now: new Date(),
        days: REFLECT_LOOKBACK_DAYS,
      });
    } finally {
      db.close();
    }
  },
};
