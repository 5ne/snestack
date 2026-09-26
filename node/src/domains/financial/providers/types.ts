import type { MorningstarData } from "../tools/morningstarParser";

export interface QuoteSnapshot {
  price: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

/** Live fundamentals pulled alongside a quote (e.g. Finnhub's Basic Financials). */
export interface LiveFundamentals {
  peRatio: number | null;
  pbRatio: number | null;
  debtToEquity: number | null;
  fcfYield: number | null;
  dividendYield: number | null;
  earningsGrowth: number | null;
  revenueGrowth: number | null;
}

/**
 * A source of live price/technical data for a ticker. QuoteAgent depends on
 * this interface, not a concrete vendor — swapping Finnhub for another quote
 * vendor means writing a new QuoteProvider, not touching QuoteAgent.
 */
export interface QuoteProvider {
  /** Latest price snapshot, or null if unavailable. */
  getQuote(ticker: string): Promise<QuoteSnapshot | null>;
  /** Historical daily closes, oldest-first, or null if unavailable. */
  getHistoricalCloses(ticker: string, days: number): Promise<number[] | null>;
  /** Live fundamentals alongside the quote (best-effort — null on any failure). */
  getFundamentals(ticker: string): Promise<LiveFundamentals | null>;
}

/**
 * A source of fundamentals + analyst judgments for a ticker (e.g. a
 * Morningstar report). EquityAgent depends on this interface, not a concrete
 * source — swapping the PDF parser for a Morningstar API subscription later
 * means writing a new FundamentalsProvider, not touching EquityAgent.
 *
 * One call returns both raw fundamentals (P/E, D/E, FCF...) and analyst-only
 * judgments (fair value, moat, rating...) together, since today's single
 * implementation parses both out of the same PDF in one pass — splitting them
 * into two methods would mean parsing the same document twice for no benefit.
 */
export interface FundamentalsProvider {
  getFundamentals(ticker: string): Promise<MorningstarData | null>;
}
