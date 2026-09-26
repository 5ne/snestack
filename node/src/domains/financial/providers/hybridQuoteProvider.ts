import type { QuoteProvider, QuoteSnapshot, LiveFundamentals } from "./types";

/**
 * Combines two QuoteProviders: one for getQuote/getFundamentals, another for
 * getHistoricalCloses. Exists because Finnhub's free tier covers quote and
 * fundamentals fine but blocks historical candles (needed for RSI/MA) —
 * Twelve Data fills just that one gap. See quoteAgent.ts for how this is wired.
 */
export class HybridQuoteProvider implements QuoteProvider {
  constructor(
    private readonly quoteAndFundamentals: QuoteProvider,
    private readonly historicalCloses: QuoteProvider
  ) {}

  getQuote(ticker: string): Promise<QuoteSnapshot | null> {
    return this.quoteAndFundamentals.getQuote(ticker);
  }

  getHistoricalCloses(ticker: string, days: number): Promise<number[] | null> {
    return this.historicalCloses.getHistoricalCloses(ticker, days);
  }

  getFundamentals(ticker: string): Promise<LiveFundamentals | null> {
    return this.quoteAndFundamentals.getFundamentals(ticker);
  }
}
