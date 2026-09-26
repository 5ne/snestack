import * as https from "https";
import { ThrottledAPIAgent, retryAsync } from "./base";
import { APIError, QuoteServiceError } from "../../../core/errors";
import type { QuoteData } from "../../../core/models";
import type { Db } from "../../../core/db";

interface FinnhubQuote {
  c: number;   // current price
  h: number;   // high
  l: number;   // low
  o: number;   // open
  pc: number;  // previous close
  v?: number;  // volume (not always present in /quote)
  t: number;   // timestamp
}

interface FinnhubCandles {
  c: number[];  // close prices
  s: string;    // status: "ok" | "no_data"
}

// Field names per Finnhub's public "Basic Financials" (/stock/metric?metric=all)
// docs. NOT independently verified against a live response in the session that
// wrote this (that sandbox had no network route to finnhub.io) — every field is
// read defensively (multiple candidate names, resolved to null on any miss), so
// a wrong/renamed field degrades to "fall back to Morningstar" rather than
// crashing or silently mis-scaling a number. If a field consistently comes back
// null for tickers where a value is expected, log the raw `metric` object once
// and true up the field name here.
interface FinnhubMetric {
  peTTM?: number | null;
  peBasicExclExtraTTM?: number | null;
  peExclExtraTTM?: number | null;
  peNormalizedAnnual?: number | null;
  pbQuarterly?: number | null;
  pbAnnual?: number | null;
  currentDividendYieldTTM?: number | null;
  dividendYieldIndicatedAnnual?: number | null;
  "totalDebt/totalEquityQuarterly"?: number | null;
  "totalDebt/totalEquityAnnual"?: number | null;
  "longTermDebt/equityQuarterly"?: number | null;
  "longTermDebt/equityAnnual"?: number | null;
  freeCashFlowTTM?: number | null;
  freeCashFlowAnnual?: number | null;
  marketCapitalization?: number | null;
  epsGrowthTTMYoy?: number | null;
  epsGrowth5Y?: number | null;
  revenueGrowthTTMYoy?: number | null;
  revenueGrowth5Y?: number | null;
}

interface FinnhubMetricResponse {
  metric?: FinnhubMetric;
}

/** Live fundamentals pulled from Finnhub's Basic Financials endpoint. */
export interface LiveFundamentals {
  peRatio: number | null;
  pbRatio: number | null;
  debtToEquity: number | null;
  fcfYield: number | null;
  dividendYield: number | null;
  earningsGrowth: number | null;
  revenueGrowth: number | null;
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
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

        const [closes, fundamentals] = await Promise.all([
          this.fetchHistoricalCloses(ticker, 250),
          this.fetchLiveFundamentals(ticker),
        ]);
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
          peRatio: fundamentals?.peRatio ?? null,
          pbRatio: fundamentals?.pbRatio ?? null,
          debtToEquity: fundamentals?.debtToEquity ?? null,
          fcfYield: fundamentals?.fcfYield ?? null,
          dividendYield: fundamentals?.dividendYield ?? null,
          earningsGrowth: fundamentals?.earningsGrowth ?? null,
          revenueGrowth: fundamentals?.revenueGrowth ?? null,
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

  /** Fetch historical close prices from Finnhub candles API. */
  private async fetchHistoricalCloses(
    ticker: string,
    days: number
  ): Promise<number[] | null> {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 24 * 60 * 60;
    const url =
      `https://finnhub.io/api/v1/stock/candle` +
      `?symbol=${encodeURIComponent(ticker)}&resolution=D` +
      `&from=${from}&to=${to}&token=${this.apiKey}`;

    return new Promise((resolve) => {
      https
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data) as FinnhubCandles;
              if (parsed.s !== "ok" || !parsed.c?.length) {
                resolve(null);
              } else {
                resolve(parsed.c); // oldest-first (Finnhub returns chronological order)
              }
            } catch {
              resolve(null);
            }
          });
        })
        .on("error", () => resolve(null));
    });
  }

  /**
   * Fetch live fundamentals (P/E, P/B, D/E, FCF yield, dividend yield, earnings
   * and revenue growth) from Finnhub's Basic Financials endpoint. Best-effort in
   * two senses: (1) the whole call resolves null rather than throwing on any
   * failure (network error, bad JSON), so a Finnhub hiccup never fails the whole
   * quote — the caller falls back to EquityData's Morningstar figures in that
   * case; (2) each individual field is read independently, so a single renamed
   * or missing field doesn't blank out the others.
   */
  private fetchLiveFundamentals(ticker: string): Promise<LiveFundamentals | null> {
    return new Promise((resolve) => {
      const url =
        `https://finnhub.io/api/v1/stock/metric` +
        `?symbol=${encodeURIComponent(ticker)}&metric=all&token=${this.apiKey}`;
      https
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data) as FinnhubMetricResponse;
              const m = parsed.metric;
              if (!m) {
                resolve(null);
                return;
              }

              const peRatio = numOrNull(
                m.peTTM ?? m.peBasicExclExtraTTM ?? m.peExclExtraTTM ?? m.peNormalizedAnnual
              );
              const pbRatio = numOrNull(m.pbQuarterly ?? m.pbAnnual);
              // Taken as-is (no /100 normalization) on the assumption Finnhub reports
              // this as a plain ratio (e.g. 1.5 meaning 1.5x), matching the convention
              // detectRedFlags() already assumes (its "High debt" threshold is > 1.5).
              // Also unverified live — if flagged debt levels look off by ~100x once
              // this runs for real, this field is reporting a percentage instead and
              // needs a /100 here. Previously this was always null (morningstarParser
              // never actually parsed it from the PDF), so this is new coverage either way.
              const debtToEquity = numOrNull(
                m["totalDebt/totalEquityQuarterly"] ??
                  m["totalDebt/totalEquityAnnual"] ??
                  m["longTermDebt/equityQuarterly"] ??
                  m["longTermDebt/equityAnnual"]
              );

              // Finnhub reports these as percentage points (e.g. 2.3 for 2.3%),
              // matching the convention EquityData/Morningstar already use
              // internally as fractions (0.023) — normalize the same way.
              const dividendYieldPct = numOrNull(
                m.currentDividendYieldTTM ?? m.dividendYieldIndicatedAnnual
              );
              const dividendYield = dividendYieldPct != null ? dividendYieldPct / 100 : null;

              const earningsGrowthPct = numOrNull(m.epsGrowthTTMYoy ?? m.epsGrowth5Y);
              const earningsGrowth = earningsGrowthPct != null ? earningsGrowthPct / 100 : null;

              const revenueGrowthPct = numOrNull(m.revenueGrowthTTMYoy ?? m.revenueGrowth5Y);
              const revenueGrowth = revenueGrowthPct != null ? revenueGrowthPct / 100 : null;

              // fcfYield computed as raw FCF / market cap rather than trusting a
              // named "yield" field — both freeCashFlowTTM and marketCapitalization
              // come from the same Finnhub payload, so whatever unit scale Finnhub
              // reports them in cancels out in the ratio. (The absolute FCF dollar
              // figure itself is intentionally NOT taken from here — see the
              // fcf field comment on QuoteData in core/models.ts.)
              const fcf = numOrNull(m.freeCashFlowTTM ?? m.freeCashFlowAnnual);
              const marketCap = numOrNull(m.marketCapitalization);
              const fcfYield = fcf != null && marketCap ? fcf / marketCap : null;

              resolve({
                peRatio,
                pbRatio,
                debtToEquity,
                fcfYield,
                dividendYield,
                earningsGrowth,
                revenueGrowth,
              });
            } catch {
              resolve(null);
            }
          });
        })
        .on("error", () => resolve(null));
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
