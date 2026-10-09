import type { QuoteRow, FundamentalsRow } from "../../core/db";
import type { QuoteData, EquityData } from "../../core/models";

/** Assemble a QuoteData-shaped object from a cached quote row + a cached Finnhub fundamentals row. */
export function quoteDataFromCache(quoteRow: QuoteRow, fundRow: FundamentalsRow): QuoteData {
  return {
    ticker: quoteRow.ticker,
    price: quoteRow.close,
    open: quoteRow.open,
    high: quoteRow.high,
    low: quoteRow.low,
    volume: quoteRow.volume,
    peRatio: fundRow.pe_ratio,
    pbRatio: fundRow.pb_ratio,
    debtToEquity: fundRow.debt_to_equity,
    fcfYield: fundRow.fcf_yield,
    fcfMargin: fundRow.fcf_margin,
    fcfPositive: fundRow.fcf_positive == null ? null : Boolean(fundRow.fcf_positive),
    dividendYield: fundRow.dividend_yield,
    earningsGrowth: fundRow.earnings_growth,
    revenueGrowth: fundRow.revenue_growth,
    rsi: quoteRow.rsi,
    ma50: quoteRow.ma_50,
    ma200: quoteRow.ma_200,
    timestamp: new Date(quoteRow.fetched_at ?? Date.now()),
  };
}

/** Assemble an EquityData-shaped object from a cached Morningstar fundamentals row. */
export function equityDataFromCache(row: FundamentalsRow): EquityData {
  let redFlags: string[] = [];
  if (row.red_flags) {
    try {
      const parsed = JSON.parse(row.red_flags);
      if (Array.isArray(parsed)) redFlags = parsed;
    } catch {
      // malformed JSON in an old row — treat as no red flags rather than failing the read
    }
  }
  return {
    ticker: row.ticker,
    peRatio: row.pe_ratio,
    pbRatio: row.pb_ratio,
    debtToEquity: row.debt_to_equity,
    fcf: row.fcf,
    fcfFiscalYear: row.fcf_fiscal_year,
    fcfYield: row.fcf_yield,
    dividendYield: row.dividend_yield,
    earningsGrowth: row.earnings_growth,
    revenueGrowth: row.revenue_growth,
    redFlags,
    fairValue: row.fair_value,
    priceToFairValue: row.price_to_fair_value,
    economicMoat: row.economic_moat,
    morningstarRating: row.morningstar_rating,
    uncertainty: row.uncertainty,
    capitalAllocation: row.capital_allocation,
    timestamp: new Date(row.fetched_at),
  };
}
