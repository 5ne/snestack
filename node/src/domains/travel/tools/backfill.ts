import * as fs from "fs";
import * as path from "path";

/** Years run newest-first from here; 2020 onward were cataloged by hand. */
export const BACKFILL_START_YEAR = 2019;
export const BACKFILL_END_YEAR = 2010;

/**
 * A year counts as done once it has an index, either canonical
 * (travel/<year>/00-index-<year>.md) or staged by the automated path
 * (travel/<year>/.nightly-draft/00-index-<year>.md). State lives entirely in
 * the filesystem, so a night that fails (no draft written) is retried.
 */
export function isYearCataloged(travelDir: string, year: number): boolean {
  return (
    fs.existsSync(path.join(travelDir, String(year), `00-index-${year}.md`)) ||
    fs.existsSync(path.join(travelDir, String(year), ".nightly-draft", `00-index-${year}.md`))
  );
}

/** The next year the nightly backfill should catalog, or null once every year is done. */
export function nextBackfillYear(travelDir: string): number | null {
  for (let year = BACKFILL_START_YEAR; year >= BACKFILL_END_YEAR; year--) {
    if (!isYearCataloged(travelDir, year)) return year;
  }
  return null;
}
