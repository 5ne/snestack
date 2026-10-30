import type { Config } from "../../core/config";
import type { Db } from "../../core/db";
import { QuoteAgent } from "./agents/quoteAgent";
import { EquityAgent } from "./agents/equityAgent";
import { resolveTickerUniverse } from "./cliHelpers";

/**
 * Separates ingestion (this is the only code path that ever calls
 * Finnhub/Twelve Data/Morningstar) from judgment (run-skill, which reads only
 * from the cache this leaves behind, via contextTools). See the financial
 * data pipeline migration plan for the full design.
 */
export type DataRefreshTier = "intraday" | "daily" | "weekly";

export const DATA_REFRESH_TIERS: readonly DataRefreshTier[] = ["intraday", "daily", "weekly"];

export async function runDataRefresh(
  tier: DataRefreshTier,
  tickersFlag: string | undefined,
  deps: { config: Config; db: Db }
): Promise<{ tickers: string[]; failed: string[] }> {
  const { config, db } = deps;
  const tickers = await resolveTickerUniverse(db, tickersFlag);
  if (tickers.length === 0) return { tickers, failed: [] };

  let results: Record<string, unknown>;
  if (tier === "intraday") {
    const quoteAgent = new QuoteAgent(config.getFinnhubApiKey(), db);
    results = await quoteAgent.batchAnalyze(tickers, { skipFundamentals: true });
  } else if (tier === "daily") {
    const quoteAgent = new QuoteAgent(config.getFinnhubApiKey(), db);
    results = await quoteAgent.batchAnalyze(tickers, { skipFundamentals: false });
  } else {
    const equityAgent = new EquityAgent(undefined, undefined, db);
    results = await equityAgent.batchAnalyze(tickers);
  }
  // Agents swallow per-ticker errors (logged at error level) and return null; surface which ones.
  const failed = tickers.filter((t) => results[t] == null);
  return { tickers, failed };
}
