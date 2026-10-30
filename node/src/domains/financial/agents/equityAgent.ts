import * as path from "path";
import { ThrottledAPIAgent } from "./base";
import { EquityServiceError } from "../../../core/errors";
import type { EquityData } from "../../../core/models";
import type { MorningstarData } from "../tools/morningstarParser";
import { MorningstarFundamentalsProvider } from "../providers/morningstarFundamentalsProvider";
import type { FundamentalsProvider } from "../providers/types";
import { getConfig } from "../../../core/config";
import type { Db } from "../../../core/db";

/** Default location of Morningstar PDFs: the shared Google Drive-synced folder, outside the repo. */
export function defaultReportsDir(): string {
  return path.join(getConfig().getBrainRoot(), "financial", "reports");
}

export class EquityAgent extends ThrottledAPIAgent<EquityData> {
  private readonly provider: FundamentalsProvider;
  private readonly db?: Db;

  constructor(reportsDir?: string, provider?: FundamentalsProvider, db?: Db) {
    super("EquityAgent", 60, 0.9);
    this.provider = provider ?? new MorningstarFundamentalsProvider(reportsDir ?? defaultReportsDir());
    this.db = db;
  }

  async analyze(ticker: string): Promise<EquityData | null> {
    await this.checkRateLimit();
    try {
      this.logger.debug(`Analyzing fundamentals for ${ticker}`);
      const fundamentals = await this.provider.getFundamentals(ticker);
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
        fcfFiscalYear: fundamentals.fcf_fiscal_year ?? null,
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

      if (this.db) {
        await this.db.addFundamentals({
          ticker,
          as_of_date: new Date().toISOString().split("T")[0],
          source: "morningstar",
          pe_ratio: result.peRatio ?? null,
          pb_ratio: result.pbRatio ?? null,
          debt_to_equity: result.debtToEquity ?? null,
          fcf: result.fcf ?? null,
          fcf_fiscal_year: result.fcfFiscalYear ?? null,
          fcf_yield: result.fcfYield ?? null,
          fcf_margin: null,
          fcf_positive: null,
          dividend_yield: result.dividendYield ?? null,
          earnings_growth: result.earningsGrowth ?? null,
          revenue_growth: result.revenueGrowth ?? null,
          fair_value: result.fairValue ?? null,
          price_to_fair_value: result.priceToFairValue ?? null,
          economic_moat: result.economicMoat ?? null,
          morningstar_rating: result.morningstarRating ?? null,
          uncertainty: result.uncertainty ?? null,
          capital_allocation: result.capitalAllocation ?? null,
          red_flags: JSON.stringify(redFlags),
        });
      }

      this.logger.info(
        `Fundamentals: ${ticker} PE=${result.peRatio} D/E=${result.debtToEquity} redFlags=${redFlags.length}`
      );
      return result;
    } catch (e) {
      this.logger.error(`Equity analysis failed for ${ticker}: ${e}`);
      throw new EquityServiceError(`Equity analysis failed for ${ticker}: ${e}`);
    }
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
