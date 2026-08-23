import * as fs from "fs";
import * as path from "path";
import { getLogger } from "../core/logger";

const logger = getLogger("MorningstarParser");

function cleanNumber(s: string): number | null {
  const cleaned = s.trim().replace(/,/g, "").replace(/%/g, "");
  if (["—", "-", "", "N/A"].includes(cleaned)) return null;
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

export interface MorningstarData {
  fair_value?: number | null;
  price_to_fair_value?: number | null;
  economic_moat?: string | null;
  uncertainty?: string | null;
  capital_allocation?: string | null;
  morningstar_rating?: number | null;
  pe_ratio?: number | null;
  pb_ratio?: number | null;
  dividend_yield?: number | null;
  revenue_growth?: number | null;
  earnings_growth?: number | null;
  fcf?: number | null;
  fcf_yield?: number | null;
  debt_to_equity?: number | null;
}

/**
 * Extract fundamental data from a Morningstar PDF (text-based).
 * Mirrors the Python pdfplumber implementation using pdf-parse.
 */
export async function parseMorningstarPdf(
  pdfPath: string
): Promise<MorningstarData> {
  let fullText: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require("pdf-parse");
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(buffer);
    fullText = data.text as string;
  } catch (e) {
    logger.warn(`Could not open ${path.basename(pdfPath)}: ${e}`);
    return {};
  }

  const result: MorningstarData = {};

  // Header: fair value, P/FVE, moat, uncertainty, capital allocation
  const headerMatch = fullText.match(
    /Last Price\s+Fair Value Estimate\s+Price\/FVE\s+Market Cap\s+Economic Moat.*?Capital Allocation\s+([\d.]+)\s+USD\s+([\d.]+)\s+USD\s+([\d.]+)\s+([\d.]+)\s+USD\s+(?:Tril|Bil)?\s*(Wide|Narrow|None)\s+.*?(Very High|High|Medium|Low|Extreme)\s+(Exemplary|Standard|Poor)/s
  );
  if (headerMatch) {
    result.fair_value = cleanNumber(headerMatch[2]);
    result.price_to_fair_value = cleanNumber(headerMatch[3]);
    result.economic_moat = headerMatch[5];
    result.uncertainty = headerMatch[6];
    result.capital_allocation = headerMatch[7];
  }

  // Morningstar star rating
  const starMatch = fullText.match(/[A-Z]{1,5}\s+(Q{1,5})\b/);
  if (starMatch) {
    result.morningstar_rating = starMatch[1].length;
  }

  // P/E, P/B, and Dividend Yield all live in the same header "valuation vs. peers"
  // table (ticker's own column first, then 3 peer/industry columns). pdf-parse strips
  // the table's cell whitespace, so the raw text looks like
  // "Price/Earning28.4237.08—27.43" and "Dividend Yield0.23%0.34%0.00%0.77%" — label
  // immediately (no space) followed by 4 concatenated values, each 2 decimal digits.
  // Anchoring on that adjacency + exactly 2 decimals isolates the ticker's own value.
  //
  // A later, unrelated multi-year valuation-history table repeats each label with a
  // *space* before single-decimal figures (e.g. "Price/Earning 24.3 23.7 29.0 ..."
  // concatenated to "24.323.729.0..."). The old regexes required that space and ended
  // up matching this wrong table instead — for most tickers they didn't match at all
  // (no match on percent-suffixed dividend yield), and for a few (e.g. DELL, GOOG,
  // NVDA) they silently returned a plausible-looking but wrong number, because
  // parseFloat() stops at the second "." in a run like "24.323.729.0...", yielding
  // 24.323 → 24.3. The adjacency + \d{2} anchor below rules that table out entirely,
  // since its figures are single-decimal and space-separated.

  // P/E ratio
  const peMatch = fullText.match(/Price\/Earning(\d+\.\d{2}|—)/);
  if (peMatch) result.pe_ratio = cleanNumber(peMatch[1]);

  // P/B ratio
  const pbMatch = fullText.match(/Price\/Book(\d+\.\d{2}|—)/);
  if (pbMatch) result.pb_ratio = cleanNumber(pbMatch[1]);

  // Dividend yield
  const divMatch = fullText.match(/Dividend Yield(\d+\.\d{2}%|—)/);
  if (divMatch) {
    const raw = divMatch[1].replace("%", "").trim();
    const val = cleanNumber(raw);
    result.dividend_yield = val != null ? val / 100 : null;
  }

  // Revenue growth
  const revGrowthMatch = fullText.match(
    /Revenue Growth %\s+([\d.,-]+)\s+([\d.,-]+)/
  );
  if (revGrowthMatch) {
    const val = cleanNumber(revGrowthMatch[2]);
    result.revenue_growth = val != null ? val / 100 : null;
  }

  // EPS growth
  const epsGrowthMatch = fullText.match(
    /Earnings Per Share Growth %\s+([\d.,-]+)\s+([\d.,-]+)/
  );
  if (epsGrowthMatch) {
    const val = cleanNumber(epsGrowthMatch[2]);
    result.earnings_growth = val != null ? val / 100 : null;
  }

  // FCF (USD Mil)
  const fcfMatch = fullText.match(
    /Free Cash Flow To The Firm \(USD Mil\)\s+([\d,.]+)/
  );
  if (fcfMatch) {
    const val = cleanNumber(fcfMatch[1]);
    result.fcf = val != null ? val * 1e6 : null;
  }

  // FCF yield
  const fcfYieldMatch = fullText.match(/Free Cash Flow Yield %\s+([\d.]+)/);
  if (fcfYieldMatch) {
    const val = cleanNumber(fcfYieldMatch[1]);
    result.fcf_yield = val != null ? val / 100 : null;
  }

  result.debt_to_equity = null;

  logger.debug(`Parsed ${path.basename(pdfPath)}: ${Object.keys(result).length} fields`);
  return result;
}

/** Return path to ticker's Morningstar PDF, or null if not found. */
export function findReport(ticker: string, reportsDir: string): string | null {
  const p = path.join(reportsDir, `${ticker.toUpperCase()}-morningstar.pdf`);
  return fs.existsSync(p) ? p : null;
}
