import * as https from "https";
import { APIError } from "../../../core/errors";
import type { QuoteProvider, QuoteSnapshot, LiveFundamentals } from "./types";

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

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/** Finnhub-backed QuoteProvider: REST calls for quote, candles, and basic financials. */
export class FinnhubQuoteProvider implements QuoteProvider {
  constructor(private readonly apiKey: string) {}

  async getQuote(ticker: string): Promise<QuoteSnapshot | null> {
    const quote = await this.fetchCurrentQuote(ticker);
    if (!quote) return null;
    return { price: quote.c, open: quote.o, high: quote.h, low: quote.l, volume: quote.v };
  }

  getHistoricalCloses(ticker: string, days: number): Promise<number[] | null> {
    return this.fetchHistoricalCloses(ticker, days);
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
  getFundamentals(ticker: string): Promise<LiveFundamentals | null> {
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
}
