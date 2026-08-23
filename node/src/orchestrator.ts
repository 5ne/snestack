import { getLogger } from "./core/logger";
import { getConfig } from "./core/config";
import { Db } from "./core/db";
import { QuoteAgent } from "./agents/quoteAgent";
import { StrategyAgent } from "./agents/strategyAgent";
import { EquityAgent } from "./agents/equityAgent";
import { CfoAgent } from "./agents/cfoAgent";
import { TraderAgent } from "./agents/traderAgent";
import { makeBatchResult } from "./core/models";
import type {
  Signal,
  BatchAnalysisResult,
  BatchAnalysisInput,
  QuoteData,
  EquityData,
} from "./core/models";

const logger = getLogger("Orchestrator");

/**
 * Merge live Finnhub fundamentals (from the quote) over the Morningstar-PDF-derived
 * ones on `equity` — real-time data wins wherever Finnhub returned a value, since
 * the PDF is only as fresh as whenever it was last downloaded (can be weeks/months
 * stale), while Finnhub is fetched fresh on every run. Falls back to equity's
 * Morningstar figure field-by-field wherever Finnhub didn't return that one
 * (rate limit, unsupported ticker, renamed field, etc.) — see quoteAgent.ts's
 * fetchLiveFundamentals() for the per-field fallback chains.
 *
 * Morningstar's own analyst judgments — fair value, price/fair-value, economic
 * moat, star rating, uncertainty, capital allocation — have no real-time
 * equivalent and are left untouched. The absolute FCF dollar amount (equity.fcf)
 * is also left as Morningstar's, deliberately: see the fcf comment on QuoteData
 * in core/models.ts for why.
 *
 * Recomputes the full red-flags list against the merged numbers afterward, so
 * flags like "High P/E ratio" or "High debt" stay consistent with whatever
 * actually gets shown in the email and handed to the CFO agent.
 */
function withLiveFundamentals(
  quote: QuoteData | null | undefined,
  equity: EquityData | null | undefined
): EquityData | null | undefined {
  if (!equity || !quote) return equity;

  const merged: EquityData = {
    ...equity,
    peRatio: quote.peRatio ?? equity.peRatio,
    pbRatio: quote.pbRatio ?? equity.pbRatio,
    debtToEquity: quote.debtToEquity ?? equity.debtToEquity,
    fcfYield: quote.fcfYield ?? equity.fcfYield,
    dividendYield: quote.dividendYield ?? equity.dividendYield,
    earningsGrowth: quote.earningsGrowth ?? equity.earningsGrowth,
    revenueGrowth: quote.revenueGrowth ?? equity.revenueGrowth,
  };

  merged.redFlags = EquityAgent.detectRedFlags({
    pe_ratio: merged.peRatio,
    debt_to_equity: merged.debtToEquity,
    fcf: merged.fcf,
    fcf_yield: merged.fcfYield,
    earnings_growth: merged.earningsGrowth,
    revenue_growth: merged.revenueGrowth,
  });

  return merged;
}

export class AnalysisOrchestrator {
  private readonly db: Db;
  private readonly quoteAgent: QuoteAgent;
  private readonly strategyAgent: StrategyAgent;
  private readonly equityAgent: EquityAgent;
  private readonly cfoAgent: CfoAgent;
  private readonly traderAgent: TraderAgent;

  constructor(db: Db) {
    this.db = db;
    const config = getConfig();

    this.quoteAgent = new QuoteAgent(config.getFinnhubApiKey(), db);
    this.strategyAgent = new StrategyAgent(db);
    this.equityAgent = new EquityAgent();
    this.cfoAgent = new CfoAgent(config.getClaudeApiKey());
    this.traderAgent = new TraderAgent(
      db,
      config.getGmailAddress(),
      config.getGmailAppPassword(),
      config.getNotificationEmail()
    );
  }

  async runBatchAnalysis(dryRun = false): Promise<BatchAnalysisResult> {
    const startTime = new Date();
    logger.info("Starting batch analysis");

    try {
      const positions = this.db.getAllPositions();
      const watchlist = this.db.getWatchlist();
      const positionTickers = positions.map((p) => p.ticker);
      const watchlistTickers = watchlist.map((w) => w.ticker);
      const allTickers = [...positionTickers, ...watchlistTickers];

      logger.info(
        `Analyzing ${positionTickers.length} positions + ${watchlistTickers.length} watchlist`
      );

      if (allTickers.length === 0) {
        logger.warn("No tickers to analyze");
        return makeBatchResult([], {}, startTime, new Date());
      }

      // Run agents in parallel
      const [quotes, strategies, equities] = await Promise.all([
        this.quoteAgent.batchAnalyze(allTickers),
        this.strategyAgent.batchAnalyze(allTickers),
        this.equityAgent.batchAnalyze(allTickers),
      ]);

      // Merge live Finnhub fundamentals over Morningstar's once per ticker — reused
      // for both the CFO's input and the email (so what the CFO reasoned about is
      // exactly what shows up in the email's financials).
      const mergedEquities: Record<string, EquityData | null | undefined> = {};
      for (const ticker of allTickers) {
        mergedEquities[ticker] = withLiveFundamentals(quotes[ticker], equities[ticker]);
      }

      const cfoInput: BatchAnalysisInput[] = allTickers.map((ticker) => ({
        ticker,
        quote: quotes[ticker],
        strategy: strategies[ticker],
        equity: mergedEquities[ticker],
      }));

      logger.info("Synthesizing via Claude CFO agent");
      const signals = await this.cfoAgent.batchAnalyze(cfoInput);

      // Tag watchlist signals
      const watchlistSet = new Set(watchlistTickers);
      signals.forEach((s) => {
        s.fromWatchlist = watchlistSet.has(s.ticker);
      });

      if (!dryRun) {
        logger.info(`Sending email with ${signals.length} signals`);
        const ok = await this.traderAgent.sendBatchEmail(
          signals,
          mergedEquities,
          startTime.toISOString().split("T")[0]
        );
        if (!ok) logger.warn("Email send failed, signals queued for retry");
      } else {
        logger.info("[DRY RUN] Would send email");
      }

      // Collect errors (tickers where quote or equity failed)
      const errors: Record<string, string> = {};
      for (const ticker of allTickers) {
        if (!quotes[ticker]) errors[ticker] = "Quote fetch failed";
        else if (!equities[ticker]) errors[ticker] = "Equity fetch failed";
      }

      const endTime = new Date();
      logger.info(
        `Batch complete: ${signals.length} signals, ${Object.keys(errors).length} errors, ` +
          `${((endTime.getTime() - startTime.getTime()) / 1000).toFixed(1)}s`
      );
      return makeBatchResult(signals, errors, startTime, endTime);
    } catch (e) {
      logger.error(`Batch analysis failed: ${e}`);
      return makeBatchResult([], { _orchestrator: String(e) }, startTime, new Date());
    }
  }

  async analyzeSingleTicker(ticker: string): Promise<Signal | null> {
    logger.info(`Analyzing single ticker: ${ticker}`);
    try {
      const [quote, strategy, equity] = await Promise.all([
        this.quoteAgent.safeAnalyze(ticker),
        this.strategyAgent.safeAnalyze(ticker),
        this.equityAgent.safeAnalyze(ticker),
      ]);

      const signals = await this.cfoAgent.batchAnalyze([
        { ticker, quote, strategy, equity: withLiveFundamentals(quote, equity) },
      ]);
      return signals[0] ?? null;
    } catch (e) {
      logger.error(`Single ticker analysis failed: ${e}`);
      return null;
    }
  }

  async retryPendingEmails(): Promise<number> {
    logger.info("Retrying pending email notifications");
    return this.traderAgent.retryPendingNotifications();
  }
}

// Convenience functions
export async function runBatch(db: Db, dryRun = false): Promise<BatchAnalysisResult> {
  return new AnalysisOrchestrator(db).runBatchAnalysis(dryRun);
}

export async function runSingle(db: Db, ticker: string): Promise<Signal | null> {
  return new AnalysisOrchestrator(db).analyzeSingleTicker(ticker);
}
