import * as path from "path";
import { ThrottledAPIAgent } from "./base";
import { EquityServiceError } from "../../../core/errors";
import type { EquityData } from "../../../core/models";
import { findReport, parseMorningstarPdf, type MorningstarData } from "../tools/morningstarParser";

export class EquityAgent extends ThrottledAPIAgent<EquityData> {
  private readonly reportsDir: string;

  constructor(reportsDir?: string) {
    super("EquityAgent", 60, 0.9);
    this.reportsDir = reportsDir ?? path.join(process.cwd(), "..", "reports");
  }

  async analyze(ticker: string): Promise<EquityData | null> {
    await this.checkRateLimit();
    try {
      this.logger.debug(`Analyzing fundamentals for ${ticker}`);
      const fundamentals = await this.fetchFundamentals(ticker);
      if (!fundamentals) {
        this.logger.warn(`No fundamental data for ${ticker}`);
        return null;
      }

      const redFlags = EquityAgent.detectRedFlags(fundamentals);
      const result: EquityData = {
        ticker,
        peRatio: fundamentals.pe_ratio ?? null,
        pbRatio: fundamentals.pb_ratio ?? null,
        debtToEquity: fundamentals.debt_to_equity ?? null,
        fcf: fundamentals.fcf ?? null,
        fcfYield: fundamentals.fcf_yield ?? null,
        dividendYield: fundamentals.dividend_yield ?? null,
        earningsGrowth: fundamentals.earnings_growth ?? null,
        revenueGrowth: fundamentals.revenue_growth ?? null,
        redFlags,
        fairValue: fundamentals.fair_value ?? null,
        priceToFairValue: fundamentals.price_to_fair_value ?? null,
        economicMoat: fundamentals.economic_moat ?? null,
        morningstarRating: fundamentals.morningstar_rating ?? null,
        uncertainty: fundamentals.uncertainty ?? null,
        capitalAllocation: fundamentals.capital_allocation ?? null,
        timestamp: new Date(),
      };

      this.logger.info(
        `Fundamentals: ${ticker} PE=${result.peRatio} D/E=${result.debtToEquity} redFlags=${redFlags.length}`
      );
      return result;
    } catch (e) {
      this.logger.error(`Equity analysis failed for ${ticker}: ${e}`);
      throw new EquityServiceError(`Equity analysis failed for ${ticker}: ${e}`);
    }
  }

  private async fetchFundamentals(
    ticker: string
  ): Promise<MorningstarData | null> {
    const pdfPath = findReport(ticker, this.reportsDir);
    if (!pdfPath) {
      this.logger.warn(
        `No Morningstar report found for ${ticker} in ${this.reportsDir}`
      );
      return null;
    }
    return parseMorningstarPdf(pdfPath);
  }

  static detectRedFlags(fundamentals: MorningstarData): string[] {
    const flags: string[] = [];
    const pe = fundamentals.pe_ratio ?? undefined;
    const de = fundamentals.debt_to_equity ?? undefined;
    const fcf = fundamentals.fcf ?? undefined;
    const fcfYield = fundamentals.fcf_yield ?? undefined;
    const eg = fundamentals.earnings_growth ?? undefined;
    const rg = fundamentals.revenue_growth ?? undefined;

    if (pe && pe > 40) flags.push(`High P/E ratio: ${pe.toFixed(1)}`);
    if (de && de > 1.5) flags.push(`High debt: D/E = ${de.toFixed(2)}`);
    if (fcf != null && fcf < 0) flags.push("Negative free cash flow");
    if (fcfYield != null && fcfYield < 0.01)
      flags.push(`Weak FCF yield: ${(fcfYield * 100).toFixed(1)}%`);
    if (eg != null && eg < 0)
      flags.push(`Declining earnings: ${(eg * 100).toFixed(1)}%`);
    if (rg != null && rg < 0)
      flags.push(`Declining revenue: ${(rg * 100).toFixed(1)}%`);
    if (pe && pe > 30 && eg != null && eg < 0.05)
      flags.push("High valuation with slow growth");
    if (de && de > 1.0 && fcfYield != null && fcfYield < 0.015)
      flags.push("High debt with weak cash generation");

    return flags;
  }

  async batchAnalyze(
    tickers: string[]
  ): Promise<Record<string, EquityData | null>> {
    const results = await Promise.all(tickers.map((t) => this.safeAnalyze(t)));
    return Object.fromEntries(tickers.map((t, i) => [t, results[i]]));
  }
}
