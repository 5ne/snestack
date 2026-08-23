// Ambient declaration for yahoo-finance2 v2.x (ESM-only, no bundled CJS types).
// We declare only what quoteAgent.ts uses.
declare module "yahoo-finance2" {
  export interface HistoricalRow {
    date: Date;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
  }

  interface YahooFinance {
    historical(
      symbol: string,
      options: { period1: string; period2: string; interval?: string }
    ): Promise<HistoricalRow[]>;
  }

  const yahooFinance: YahooFinance;
  export default yahooFinance;
}
