import type { Db } from "../../core/db";

/**
 * Resolve the set of tickers a financial CLI command should operate on:
 * an explicit comma-separated `--tickers` flag if given, otherwise the union
 * of current positions and watchlist tickers. Shared by `data-dump` and
 * `data-refresh` rather than each re-deriving it.
 */
export function resolveTickerUniverse(db: Db, tickersFlag?: string): string[] {
  if (tickersFlag) {
    return [...new Set(tickersFlag.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
  }
  const positions = db.getAllPositions();
  const watchlist = db.getWatchlist();
  return [...new Set([...positions.map((p) => p.ticker), ...watchlist.map((w) => w.ticker)])];
}
