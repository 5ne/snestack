import { getLogger } from "../../core/logger";
import { getConfig } from "../../core/config";
import { Db } from "../../core/db";
import { QuoteAgent } from "./agents/quoteAgent";
import { StrategyAgent } from "./agents/strategyAgent";
import { EquityAgent } from "./agents/equityAgent";
import { CfoAgent } from "./agents/cfoAgent";
import { TraderAgent } from "./agents/traderAgent";
import { makeBatchResult } from "../../core/models";
import type {
  Signal,
  BatchAnalysisResult,
  BatchAnalysisInput,
  QuoteData,
  EquityData,
} from "../../core/models";

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

/**
 * @deprecated Legacy pipeline — wires up the deprecated CfoAgent for judgment
 * instead of going through domains/financial/skills/. The intended path is
 * `fstack data-dump` -> a Claude session reasoning over the skill markdown +
 * brain files -> `fstack notify` (see skills/INDEX.md's "Status" section).
 * Kept for reference via the `batch`/`analyze` CLI commands, not deleted yet.
 */
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

      // Every stage that can silently degrade a ticker's data gets recorded here —
      // this is what lets the email (and the CLI's error summary below) say "this
      // recommendation was made with incomplete/missing data" instead of presenting
      // a fallback HOLD/50% as indistinguishable from a genuine one.
      const analysisIssues: Record<string, string[]> = {};
      const addIssue = (ticker: string, msg: string) => {
        (analysisIssues[ticker] ??= []).push(msg);
      };
      for (const ticker of allTickers) {
        if (!quotes[ticker]) addIssue(ticker, "No live quote data — Finnhub fetch failed");
        if (!equities[ticker])
          addIssue(ticker, "No fundamentals data — no Morningstar report found for this ticker");
      }

      const cfoInput: BatchAnalysisInput[] = allTickers.map((ticker) => ({
        ticker,
        quote: quotes[ticker],
        strategy: strategies[ticker],
        equity: mergedEquities[ticker],
      }));

      logger.info("Synthesizing via Claude CFO agent");
      const { signals, issues: cfoIssues } = await this.cfoAgent.batchAnalyze(cfoInput);
      for (const [ticker, msg] of Object.entries(cfoIssues)) addIssue(ticker, msg);

      // Tag watchlist signals
      const watchlistSet = new Set(watchlistTickers);
      signals.forEach((s) => {
        s.fromWatchlist = watchlistSet.has(s.ticker);
      });

      if (!dryRun) {
        logger.info(
          `Sending email with ${signals.length} signals` +
            (Object.keys(analysisIssues).length
              ? ` (${Object.keys(analysisIssues).length} with data/analysis issues)`
              : "")
        );
        const ok = await this.traderAgent.sendBatchEmail(
          signals,
          mergedEquities,
          analysisIssues,
          startTime.toISOString().split("T")[0]
        );
        if (!ok) logger.warn("Email send failed, signals queued for retry");
      } else {
        logger.info("[DRY RUN] Would send email");
      }

      // Collect errors (tickers with a quote, equity, or CFO-synthesis issue)
      const errors: Record<string, string> = {};
      for (const [ticker, msgs] of Object.entries(analysisIssues)) {
        errors[ticker] = msgs.join("; ");
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

      const { signals, issues } = await this.cfoAgent.batchAnalyze([
        { ticker, quote, strategy, equity: withLiveFundamentals(quote, equity) },
      ]);
      if (issues[ticker]) logger.warn(`${ticker}: ${issues[ticker]}`);
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
