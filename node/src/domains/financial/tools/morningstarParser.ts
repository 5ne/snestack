import * as fs from "fs";
import * as path from "path";
import { getLogger } from "../../../core/logger";

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
  /** Fiscal year the `fcf` figure belongs to (the latest actual year in Morningstar's table). */
  fcf_fiscal_year?: number | null;
  fcf_yield?: number | null;
  debt_to_equity?: number | null;
}

/** One positioned piece of text from a PDF page (pdf.js text item). */
export interface PdfTextItem {
  page: number;
  x: number;
  y: number;
  w: number;
  s: string;
}

/**
 * Morningstar's financial table renders each year's figures as separate
 * positioned cells, but plain-text extraction glues them into one unsplittable
 * run of digits ("42,66257,08051,844..."). Working from cell positions keeps
 * the columns apart.
 *
 * Takes the "Free Cash Flow To The Firm (USD Mil|Bil)" row — Morningstar's FCFF,
 * which approximates but is not identical to reported FCF — and returns the
 * third column, the latest actual year (the table shows 3 actual years followed
 * by 5 forecasts). The year comes from the header row whose column lines up with
 * that value's right edge. The unit varies by company (mega-caps like NVDA are
 * reported in whole billions, so those figures are rounded to the nearest $1B).
 * Returns null if the row isn't found.
 */
export function extractFcfFromItems(
  items: PdfTextItem[]
): { fcf: number; fiscalYear: number | null } | null {
  const lines = new Map<string, PdfTextItem[]>();
  for (const it of items) {
    const key = `${it.page}|${Math.round(it.y)}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push(it);
  }

  const numberRe = /^-?[\d,]+(\.\d+)?$/;
  for (const [key, row] of lines) {
    row.sort((a, b) => a.x - b.x);
    const unitMatch = row
      .map((i) => i.s)
      .join("")
      .match(/Free\s*Cash\s*Flow\s*To.*\(USD\s*(Mil|Bil|Tril)\)/i);
    if (!unitMatch) continue;
    const unitMultiplier = { mil: 1e6, bil: 1e9, tril: 1e12 }[unitMatch[1].toLowerCase() as "mil" | "bil" | "tril"];

    const values = row.filter((i) => numberRe.test(i.s.trim()));
    if (values.length < 3) continue;
    const latestActual = values[2];
    const fcfInUnits = cleanNumber(latestActual.s);
    if (fcfInUnits == null) continue;

    const page = parseInt(key.split("|")[0], 10);
    const rightEdge = latestActual.x + latestActual.w;
    const yearItem = items.find(
      (i) =>
        i.page === page &&
        /^\s*(19|20)\d\d\s*$/.test(i.s) &&
        Math.abs(i.x + i.w - rightEdge) < 5
    );
    return {
      fcf: fcfInUnits * unitMultiplier,
      fiscalYear: yearItem ? parseInt(yearItem.s.trim(), 10) : null,
    };
  }
  return null;
}

/**
 * Extract fundamental data from a Morningstar PDF (text-based).
 * Mirrors the Python pdfplumber implementation using pdf-parse.
 */
export async function parseMorningstarPdf(
  pdfPath: string
): Promise<MorningstarData> {
  let fullText: string;
  const items: PdfTextItem[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require("pdf-parse");
    const buffer = fs.readFileSync(pdfPath);
    // Custom page renderer: builds exactly the text pdf-parse's default renderer
    // would (every regex below depends on it), while also recording each text
    // item's position for extractFcfFromItems.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pagerender = (pageData: any) =>
      pageData
        .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((tc: any) => {
          let lastY: number | undefined;
          let text = "";
          for (const it of tc.items) {
            items.push({
              page: pageData.pageNumber,
              x: it.transform[4],
              y: it.transform[5],
              w: it.width,
              s: it.str,
            });
            if (lastY === it.transform[5] || !lastY) text += it.str;
            else text += "\n" + it.str;
            lastY = it.transform[5];
          }
          return text;
        });
    const data = await pdfParse(buffer, { pagerender });
    fullText = data.text as string;
  } catch (e) {
    logger.warn(`Could not open ${path.basename(pdfPath)}: ${e}`);
    return {};
  }

  const result: MorningstarData = {};

  // Header: fair value, P/FVE, moat, uncertainty, capital allocation.
  // pdf-parse renders this header as label, then value, each on their own
  // line (with inconsistent extra whitespace/line breaks within a label
  // across reports) — not all labels grouped before all values as a single
  // block, so each field needs its own label->value match rather than one
  // regex spanning the whole header.
  const fairValueMatch = fullText.match(/Fair\s+Value\s+Estimate\s*[\r\n]+([\d.]+)\s*USD/);
  if (fairValueMatch) result.fair_value = cleanNumber(fairValueMatch[1]);

  const priceToFairValueMatch = fullText.match(/Price\/FVE\s*[\r\n]+([\d.]+)/);
  if (priceToFairValueMatch) result.price_to_fair_value = cleanNumber(priceToFairValueMatch[1]);

  const moatMatch = fullText.match(
    /Economic\s+Moat\s*[\r\n]+TM\s*[\r\n]+(Wide|Narrow|None)/
  );
  if (moatMatch) result.economic_moat = moatMatch[1];

  const uncertaintyMatch = fullText.match(
    /Uncertainty\s*[\r\n]+(Very High|High|Medium|Low|Extreme)/
  );
  if (uncertaintyMatch) result.uncertainty = uncertaintyMatch[1];

  const capitalAllocationMatch = fullText.match(
    /Capital\s+Allocation\s*[\r\n]+(Exemplary|Standard|Poor)/
  );
  if (capitalAllocationMatch) result.capital_allocation = capitalAllocationMatch[1];

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

  // FCF (Morningstar's FCFF, latest actual year) — from cell positions, since the
  // plain text fuses the row's eight values together.
  const fcfRow = extractFcfFromItems(items);
  if (fcfRow) {
    result.fcf = fcfRow.fcf;
    result.fcf_fiscal_year = fcfRow.fiscalYear;
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
