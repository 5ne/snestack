import type { Db } from "../../core/db";

/**
 * Resolve the set of tickers a financial CLI command should operate on:
 * an explicit comma-separated `--tickers` flag if given, otherwise the union
 * of current positions and watchlist tickers. Shared by `data-dump` and
 * `data-refresh` rather than each re-deriving it.
 */
export async function resolveTickerUniverse(db: Db, tickersFlag?: string): Promise<string[]> {
  if (tickersFlag) {
    return [...new Set(tickersFlag.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
  }
  const positions = await db.getAllPositions();
  const watchlist = await db.getWatchlist();
  return [...new Set([...positions.map((p) => p.ticker), ...watchlist.map((w) => w.ticker)])];
}

/**
 * Read every ticker's cache ages up front and hand back synchronous getters,
 * since `checkCacheStaleness` (core/runCheck.ts) takes sync lookups but the db is async.
 */
export async function loadCacheAgeGetters(db: Db, tickers: string[]): Promise<{
  getLatestQuoteAge: (ticker: string) => number | null;
  getLatestFundamentalsAge: (ticker: string, source: "finnhub" | "morningstar") => number | null;
}> {
  const ageMs = (fetchedAt: string | null | undefined): number | null => (fetchedAt ? Date.now() - Date.parse(fetchedAt) : null);
  const quoteAges = new Map<string, number | null>();
  const fundAges = new Map<string, number | null>();
  for (const ticker of tickers) {
    quoteAges.set(ticker, ageMs((await db.getLatestQuote(ticker))?.fetched_at));
    for (const source of ["finnhub", "morningstar"] as const) {
      fundAges.set(`${ticker}|${source}`, ageMs((await db.getLatestFundamentals(ticker, source))?.fetched_at));
    }
  }
  return {
    getLatestQuoteAge: (ticker) => quoteAges.get(ticker) ?? null,
    getLatestFundamentalsAge: (ticker, source) => fundAges.get(`${ticker}|${source}`) ?? null,
  };
}
