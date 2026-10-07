import { ThrottledAPIAgent, retryAsync } from "./base";
import { QuoteServiceError } from "../../../core/errors";
import type { QuoteData } from "../../../core/models";
import type { Db } from "../../../core/db";
import { getConfig } from "../../../core/config";
import { FinnhubQuoteProvider } from "../providers/finnhubQuoteProvider";
import { TwelveDataQuoteProvider } from "../providers/twelveDataQuoteProvider";
import { HybridQuoteProvider } from "../providers/hybridQuoteProvider";
import type { QuoteProvider, LiveFundamentals } from "../providers/types";

/**
 * Finnhub covers quote + fundamentals fine; its free tier blocks historical
 * candles (needed for RSI/MA). If a Twelve Data key is configured, pair it in
 * for just that piece. Otherwise fall back to Finnhub alone (historical
 * closes resolve null, same as before — no regression either way).
 */
function buildDefaultQuoteProvider(finnhubApiKey: string): QuoteProvider {
  const finnhub = new FinnhubQuoteProvider(finnhubApiKey);
  const twelveDataApiKey = getConfig().getTwelveDataApiKey();
  if (!twelveDataApiKey) return finnhub;
  return new HybridQuoteProvider(finnhub, new TwelveDataQuoteProvider(twelveDataApiKey));
}

export class QuoteAgent extends ThrottledAPIAgent<QuoteData> {
  private readonly provider: QuoteProvider;
  private readonly db?: Db;

  constructor(apiKey: string, db?: Db, provider?: QuoteProvider) {
    super("QuoteAgent", 60, 0.7);
    this.provider = provider ?? buildDefaultQuoteProvider(apiKey);
    this.db = db;
  }

  async analyze(ticker: string): Promise<QuoteData | null> {
    await this.checkRateLimit();

    return retryAsync(
      async () => {
        this.logger.debug(`Fetching quote for ${ticker}`);

        const quote = await this.provider.getQuote(ticker);
        if (!quote) {
          this.logger.warn(`No quote data for ${ticker}`);
          return null;
        }

        // Reuse today's already-computed RSI/MA if a Db is available and has
        // it — Twelve Data's free tier is rate-limited (8/min), so a caller
        // that already ran data-dump today (or a prior run-skill call today)
        // shouldn't pay for another historical-closes fetch just to get the
        // same numbers back.
        const today = new Date().toISOString().split("T")[0];
        const cached = this.db?.getLatestQuote(ticker);
        const useCachedTechnicals = cached?.date === today && cached.rsi != null;

        let rsi: number | null;
        let ma50: number | null;
        let ma200: number | null;
        let fundamentals: LiveFundamentals | null;

        if (useCachedTechnicals && cached) {
          this.logger.debug(`Reusing today's cached RSI/MA for ${ticker}`);
          rsi = cached.rsi;
          ma50 = cached.ma_50;
          ma200 = cached.ma_200;
          fundamentals = await this.provider.getFundamentals(ticker);
        } else {
          const [closes, freshFundamentals] = await Promise.all([
            this.provider.getHistoricalCloses(ticker, 250),
            this.provider.getFundamentals(ticker),
          ]);
          rsi = closes ? QuoteAgent.calculateRsi(closes) : null;
          ma50 = closes ? QuoteAgent.calculateMovingAverage(closes, 50) : null;
          ma200 = closes ? QuoteAgent.calculateMovingAverage(closes, 200) : null;
          fundamentals = freshFundamentals;
        }

        const result: QuoteData = {
          ticker,
          price: quote.price,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          volume: quote.volume,
          peRatio: fundamentals?.peRatio ?? null,
          pbRatio: fundamentals?.pbRatio ?? null,
          debtToEquity: fundamentals?.debtToEquity ?? null,
          fcfYield: fundamentals?.fcfYield ?? null,
          fcfMargin: fundamentals?.fcfMargin ?? null,
          fcfPositive: fundamentals?.fcfPositive ?? null,
          dividendYield: fundamentals?.dividendYield ?? null,
          earningsGrowth: fundamentals?.earningsGrowth ?? null,
          revenueGrowth: fundamentals?.revenueGrowth ?? null,
          rsi,
          ma50,
          ma200,
          timestamp: new Date(),
        };

        if (this.db && !useCachedTechnicals && quote.open && quote.high && quote.low && quote.price) {
          this.db.addQuote(
            ticker,
            today,
            quote.open,
            quote.high,
            quote.low,
            quote.price,
            quote.volume ?? 0,
            rsi,
            ma50,
            ma200
          );
        }

        this.logger.info(
          `Quote: ${ticker} @ $${result.price.toFixed(2)}` +
            (result.peRatio != null ? ` (P/E ${result.peRatio.toFixed(1)})` : "")
        );
        return result;
      },
      { maxAttempts: 3 }
    ).catch((e) => {
      throw new QuoteServiceError(`Quote fetch failed for ${ticker}: ${e}`);
    });
  }

  /** Calculate RSI-14 from an array of closing prices (oldest first). */
  static calculateRsi(prices: number[], period = 14): number | null {
    if (prices.length < period + 1) return null;
    const recent = prices.slice(-(period + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < recent.length; i++) {
      const change = recent[i] - recent[i - 1];
      if (change > 0) gains += change;
      else losses += -change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
    const rs = avgGain / avgLoss;
    return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
  }

  /** Calculate simple moving average. */
  static calculateMovingAverage(prices: number[], period: number): number | null {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    const avg = slice.reduce((a, b) => a + b, 0) / period;
    return Math.round(avg * 100) / 100;
  }

  async batchAnalyze(tickers: string[]): Promise<Record<string, QuoteData | null>> {
    const results = await Promise.all(tickers.map((t) => this.safeAnalyze(t)));
    return Object.fromEntries(tickers.map((t, i) => [t, results[i]]));
  }
}
