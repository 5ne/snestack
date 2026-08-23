import * as https from "https";
import { ThrottledAPIAgent, retryAsync } from "./base";
import { APIError, QuoteServiceError } from "../core/errors";
import type { QuoteData } from "../core/models";
import type { Db } from "../core/db";

interface FinnhubQuote {
  c: number;   // current price
  h: number;   // high
  l: number;   // low
  o: number;   // open
  pc: number;  // previous close
  v?: number;  // volume (not always present in /quote)
  t: number;   // timestamp
}

interface YahooHistorical {
  date: Date;
  close: number;
}

export class QuoteAgent extends ThrottledAPIAgent<QuoteData> {
  private readonly apiKey: string;
  private readonly db?: Db;

  constructor(apiKey: string, db?: Db) {
    super("QuoteAgent", 60, 0.7);
    this.apiKey = apiKey;
    this.db = db;
  }

  async analyze(ticker: string): Promise<QuoteData | null> {
    await this.checkRateLimit();

    return retryAsync(
      async () => {
        this.logger.debug(`Fetching quote for ${ticker}`);

        const quoteData = await this.fetchCurrentQuote(ticker);
        if (!quoteData) {
          this.logger.warn(`No quote data for ${ticker}`);
          return null;
        }

        const closes = await this.fetchHistoricalCloses(ticker, 250);
        const rsi = closes ? QuoteAgent.calculateRsi(closes) : null;
        const ma50 = closes ? QuoteAgent.calculateMovingAverage(closes, 50) : null;
        const ma200 = closes ? QuoteAgent.calculateMovingAverage(closes, 200) : null;

        const result: QuoteData = {
          ticker,
          price: quoteData.c,
          open: quoteData.o,
          high: quoteData.h,
          low: quoteData.l,
          volume: quoteData.v,
          timestamp: new Date(),
        };

        if (this.db && quoteData.o && quoteData.h && quoteData.l && quoteData.c) {
          const today = new Date().toISOString().split("T")[0];
          this.db.addQuote(
            ticker,
            today,
            quoteData.o,
            quoteData.h,
            quoteData.l,
            quoteData.c,
            quoteData.v ?? 0,
            rsi,
            ma50,
            ma200
          );
        }

        this.logger.info(`Quote: ${ticker} @ $${result.price.toFixed(2)}`);
        return result;
      },
      { maxAttempts: 3 }
    ).catch((e) => {
      throw new QuoteServiceError(`Quote fetch failed for ${ticker}: ${e}`);
    });
  }

  /** Fetch current quote from Finnhub REST API. */
  private fetchCurrentQuote(ticker: string): Promise<FinnhubQuote | null> {
    return new Promise((resolve, reject) => {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${this.apiKey}`;
      https
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data) as FinnhubQuote;
              if (!parsed.c || parsed.c === 0) {
                resolve(null);
              } else {
                resolve(parsed);
              }
            } catch (e) {
              reject(new APIError(`Finnhub parse error: ${e}`));
            }
          });
        })
        .on("error", (e) => reject(new APIError(`Finnhub request failed: ${e}`)));
    });
  }

  /** Fetch historical close prices via yahoo-finance2. */
  private async fetchHistoricalCloses(
    ticker: string,
    days: number
  ): Promise<number[] | null> {
    try {
      // yahoo-finance2 is ESM-only in v2.x — must use dynamic import()
      const { default: yahooFinance } = await import("yahoo-finance2");
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
      const result = await yahooFinance.historical(ticker, {
        period1: startDate.toISOString().split("T")[0],
        period2: endDate.toISOString().split("T")[0],
        interval: "1d",
      }) as YahooHistorical[];
      const closes = result
        .filter((r) => r.close != null)
        .map((r) => r.close)
        .sort((a, b) => a - b); // oldest first by sorting (historical returns sorted)
      return closes.length > 0 ? closes : null;
    } catch (e) {
      this.logger.warn(`Failed to fetch historical data for ${ticker}: ${e}`);
      return null;
    }
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
