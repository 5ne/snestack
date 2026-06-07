import * as fs from "fs";
import * as path from "path";
import { getLogger } from "../core/logger";

const logger = getLogger("ReportOrganizer");

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
