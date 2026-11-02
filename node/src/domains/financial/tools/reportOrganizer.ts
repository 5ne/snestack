import * as fs from "fs";
import * as path from "path";
import prompts from "prompts";
import { getLogger } from "../../../core/logger";

const logger = getLogger("ReportOrganizer");

const TICKER_EXCLUDED = new Set([
  "UTC", "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "INR", "SGD", "HKD", "CNY",
  // "MORN" is Morningstar's own ticker, which appears in every report's boilerplate
  // disclaimer ("Morningstar, Inc. is a publicly traded company (Ticker Symbol: MORN)")
  // and can be mistaken for the subject company's ticker when no other pattern matches first.
  "MORN",
]);

// Regex candidates for ticker extraction from Morningstar PDF text, in the
// same order/priority as the Python OCR implementation.
//
// Every capture group is followed by (?![a-z]) so it can't stop partway
// through a longer word (e.g. matching just "S" out of "Symbol") — without
// that guard, the "Ticker Symbol: MORN" boilerplate that appears in every
// report's disclaimer footer can be mistaken for the subject company's
// ticker when no earlier pattern matches first.
const TICKER_PATTERNS: RegExp[] = [
  /[\s\n]([A-Z]{1,5})(?![a-z])\s+Q{1,5}(?:\s|$|\n)/g, // "Company Name TICKER Q/QQQQQ" (1-5 star rating)
  /\b([A-Z]{1,5})(?![a-z])\s+\(/g, // "NVDA ("
  /Ticker[:\s]+([A-Z]{1,5})(?![a-z])/g, // "Ticker: NVDA"
  /\(([A-Z]{1,5})(?![a-z])\)/g, // "(NVDA)"
  /Symbol[:\s]+([A-Z]{1,5})(?![a-z])/g, // "Symbol: NVDA"
  /\s([A-Z]{1,5})(?![a-z])\s(?:Inc|Corp|LLC|Ltd|Ltd\.|Co|Co\.)/g, // "NVDA Corp"
];

/**
 * Archive a Morningstar report by copying it to the archive directory
 * with a date-stamped filename: {TICKER}-{YYYY-MM-DD}-morningstar.pdf
 */
export function archiveReport(
  srcPath: string,
  archiveDir: string,
  date?: string
): string | null {
  const dateStr = date ?? new Date().toISOString().split("T")[0];
  const base = path.basename(srcPath, ".pdf");
  const destName = `${base}-${dateStr}.pdf`;
  const destPath = path.join(archiveDir, destName);

  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    logger.info(`Archived ${path.basename(srcPath)} → ${destName}`);
    return destPath;
  } catch (e) {
    logger.error(`Failed to archive ${srcPath}: ${e}`);
    return null;
  }
}

/**
 * Scan a directory for Morningstar PDFs that don't follow the
 * {TICKER}-morningstar.pdf naming convention and rename them.
 */
export function organizeReports(reportsDir: string): string[] {
  const renamed: string[] = [];
  if (!fs.existsSync(reportsDir)) return renamed;

  const files = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".pdf"));
  for (const file of files) {
    const srcPath = path.join(reportsDir, file);
    // Already correct format
    if (/^[A-Z]+-morningstar\.pdf$/i.test(file)) continue;

    // Try to extract ticker from filename
    const tickerMatch = file.match(/^([A-Z]{1,5})/i);
    if (!tickerMatch) continue;

    const ticker = tickerMatch[1].toUpperCase();
    const destName = `${ticker}-morningstar.pdf`;
    const destPath = path.join(reportsDir, destName);

    if (!fs.existsSync(destPath)) {
      try {
        fs.renameSync(srcPath, destPath);
        renamed.push(destName);
        logger.info(`Renamed ${file} → ${destName}`);
      } catch (e) {
        logger.warn(`Could not rename ${file}: ${e}`);
      }
    }
  }
  return renamed;
}

// ── Staging workflow ─────────────────────────────────────────────────────
//
// Extracts a ticker from a freshly-downloaded Morningstar PDF (regex over
// the extracted text) and, when that fails, prompts the user to type it in
// by hand. This is a simplified port of the Python implementation, which
// also fell back to asking Claude Haiku to read the PDF; that fallback is
// intentionally not ported here.

/**
 * Extract a ticker symbol from Morningstar PDF text via regex heuristics.
 * Returns the first plausible candidate found, or null if none match.
 */
export function extractTickerFromText(text: string): string | null {
  if (!text) return null;

  const candidates: string[] = [];
  for (const pattern of TICKER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      candidates.push(match[1]);
    }
  }

  const seen = new Set<string>();
  const validCandidates: string[] = [];
  for (const raw of candidates) {
    const candidate = raw.toUpperCase().trim();
    if (
      candidate.length >= 1 &&
      candidate.length <= 5 &&
      /^[A-Z]+$/.test(candidate) &&
      !seen.has(candidate) &&
      !TICKER_EXCLUDED.has(candidate)
    ) {
      validCandidates.push(candidate);
      seen.add(candidate);
    }
  }

  return validCandidates.length > 0 ? validCandidates[0] : null;
}

/** Extract text from a PDF and run ticker extraction against it. */
async function findTickerInPdf(pdfPath: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require("pdf-parse");
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(buffer);
    return extractTickerFromText(data.text as string);
  } catch (e) {
    logger.warn(`Could not extract text from ${path.basename(pdfPath)}: ${e}`);
    return null;
  }
}

/**
 * Organize a single staged report: extract its ticker (or ask the user),
 * then copy it into target/archive with the standard naming convention and
 * remove it from staging. Returns the ticker on success, or null if the
 * file was skipped.
 */
export async function organizeReport(
  pdfPath: string,
  targetDir: string,
  archiveDir: string
): Promise<string | null> {
  const pdfName = path.basename(pdfPath);
  let ticker = await findTickerInPdf(pdfPath);

  if (ticker) {
    logger.info(`Extracted: ${pdfName} → ${ticker}`);
  } else {
    console.log(`\nOrganizing: ${pdfName}`);
    const { manualTicker } = await prompts({
      type: "text",
      name: "manualTicker",
      message: "Couldn't extract a ticker automatically. Enter ticker (blank to skip):",
    });
    if (!manualTicker) {
      console.log("Skipped.");
      return null;
    }
    ticker = String(manualTicker);
  }

  ticker = ticker.toUpperCase();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const latestPath = path.join(targetDir, `${ticker}-morningstar.pdf`);
  fs.copyFileSync(pdfPath, latestPath);

  const archivedPath = path.join(archiveDir, `${ticker}-${today}-morningstar.pdf`);
  fs.copyFileSync(pdfPath, archivedPath);

  fs.unlinkSync(pdfPath);

  logger.info(`✓ Organized: ${pdfName} → ${ticker}`);
  logger.info(`  Created: ${path.basename(latestPath)}`);
  logger.info(`  Archived: ${path.basename(archivedPath)}`);

  return ticker;
}

export interface OrganizeResult {
  success: string[];
  failed: string[];
}

/** Organize every PDF sitting in the staging folder. */
export async function organizeStagedReports(
  stagingDir: string,
  targetDir: string,
  archiveDir: string,
  errorDir: string
): Promise<OrganizeResult> {
  for (const dir of [stagingDir, targetDir, archiveDir, errorDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const pdfFiles = fs
    .readdirSync(stagingDir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(stagingDir, f));

  if (pdfFiles.length === 0) {
    logger.info("No PDFs found in staging folder.");
    return { success: [], failed: [] };
  }

  console.log(`\nFound ${pdfFiles.length} PDF(s) in staging folder`);

  const results: OrganizeResult = { success: [], failed: [] };
  for (const pdfPath of pdfFiles) {
    try {
      const ticker = await organizeReport(pdfPath, targetDir, archiveDir);
      if (ticker) results.success.push(ticker);
      else results.failed.push(path.basename(pdfPath));
    } catch (e) {
      logger.error(`Error processing ${path.basename(pdfPath)}: ${e}`);
      results.failed.push(path.basename(pdfPath));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Report Organization Summary");
  console.log("=".repeat(60));
  if (results.success.length) console.log(`✓ Successfully organized: ${results.success.join(", ")}`);
  if (results.failed.length) console.log(`✗ Failed: ${results.failed.join(", ")}`);
  console.log("=".repeat(60));

  return results;
}
