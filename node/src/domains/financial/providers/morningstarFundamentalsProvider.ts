import { getLogger } from "../../../core/logger";
import { findReport, parseMorningstarPdf, type MorningstarData } from "../tools/morningstarParser";
import type { FundamentalsProvider } from "./types";

const logger = getLogger("MorningstarFundamentalsProvider");

/** Morningstar-backed FundamentalsProvider: parses the ticker's PDF report from disk. */
export class MorningstarFundamentalsProvider implements FundamentalsProvider {
  constructor(private readonly reportsDir: string) {}

  async getFundamentals(ticker: string): Promise<MorningstarData | null> {
    const pdfPath = findReport(ticker, this.reportsDir);
    if (!pdfPath) {
      logger.warn(`No Morningstar report found for ${ticker} in ${this.reportsDir}`);
      return null;
    }
    return parseMorningstarPdf(pdfPath);
  }
}
