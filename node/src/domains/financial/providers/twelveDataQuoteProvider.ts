import * as https from "https";
import { sleep } from "../agents/base";
import type { QuoteProvider, QuoteSnapshot, LiveFundamentals } from "./types";

interface TwelveDataQuote {
  close?: string;
  open?: string;
  high?: string;
  low?: string;
  volume?: string;
  status?: string;
}

interface TwelveDataTimeSeriesValue {
  datetime: string;
  close: string;
}

interface TwelveDataTimeSeries {
  values?: TwelveDataTimeSeriesValue[];
  status?: string;
}

function get<T>(url: string): Promise<T | null> {
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}

/**
 * Twelve Data-backed QuoteProvider. Used specifically for getHistoricalCloses —
 * Finnhub's free tier blocks /stock/candle (historical OHLC), which QuoteAgent
 * needs for RSI/50MA/200MA. getQuote is implemented for completeness (this
 * provider is a fully valid standalone QuoteProvider), but the default wiring
 * in quoteAgent.ts pairs Twelve Data's historical closes with Finnhub's own
 * getQuote/getFundamentals, which already work fine — see HybridQuoteProvider.
 */
export class TwelveDataQuoteProvider implements QuoteProvider {
  // Free tier: 8 requests/minute. batchAnalyze fires every ticker concurrently
  // via Promise.all, so without serializing here they'd all land in the same
  // second and hit a 429. This queue chains calls one at a time, spaced out.
  private static readonly MIN_INTERVAL_MS = 7_600;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly apiKey: string) {}

  private throttle<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(async () => {
      const wait = TwelveDataQuoteProvider.MIN_INTERVAL_MS - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.queue = turn;
    return turn.then(fn);
  }

  getQuote(ticker: string): Promise<QuoteSnapshot | null> {
    return this.throttle(() => this.fetchQuote(ticker));
  }

  private async fetchQuote(ticker: string): Promise<QuoteSnapshot | null> {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}&apikey=${this.apiKey}`;
    const parsed = await get<TwelveDataQuote>(url);
    if (!parsed || parsed.status === "error" || !parsed.close) return null;
    const price = parseFloat(parsed.close);
    if (isNaN(price)) return null;
    return {
      price,
      open: parsed.open ? parseFloat(parsed.open) : undefined,
      high: parsed.high ? parseFloat(parsed.high) : undefined,
      low: parsed.low ? parseFloat(parsed.low) : undefined,
      volume: parsed.volume ? parseFloat(parsed.volume) : undefined,
    };
  }

  /** Daily closes, oldest-first (Twelve Data returns newest-first — reversed here). */
  getHistoricalCloses(ticker: string, days: number): Promise<number[] | null> {
    return this.throttle(() => this.fetchHistoricalCloses(ticker, days));
  }

  private async fetchHistoricalCloses(ticker: string, days: number): Promise<number[] | null> {
    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(ticker)}&interval=1day&outputsize=${days}&apikey=${this.apiKey}`;
    const parsed = await get<TwelveDataTimeSeries>(url);
    if (!parsed || parsed.status !== "ok" || !parsed.values?.length) return null;
    const closes = parsed.values
      .map((v) => parseFloat(v.close))
      .filter((n) => !isNaN(n));
    if (!closes.length) return null;
    return closes.reverse(); // API returns newest-first; callers expect oldest-first
  }

  /**
   * Not implemented — Twelve Data's fundamentals are a separate, more limited
   * product on the free tier. Finnhub already covers this fine; this provider
   * exists only to fill Finnhub's historical-candle gap. Always resolves null,
   * matching the "best-effort, degrade to the other source" convention.
   */
  async getFundamentals(_ticker: string): Promise<LiveFundamentals | null> {
    return null;
  }
}
