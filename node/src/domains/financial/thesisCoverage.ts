import * as fs from "fs";
import * as path from "path";
import { dayString, type Finding } from "../../core/runCheck";

export type ThesisStatus = "covered" | "missing_file" | "empty_thesis";

export interface TickerThesisCoverage {
  ticker: string;
  status: ThesisStatus;
  hasThesis: boolean;
  filePath: string;
}

export interface ThesisCoverageReport {
  total: number;
  covered: string[];
  missingFile: string[];
  emptyThesis: string[];
  uncovered: TickerThesisCoverage[];
  items: TickerThesisCoverage[];
}

export function companyBrainPath(brainRoot: string, ticker: string): string {
  return path.join(
    brainRoot,
    "financial",
    "brain",
    "investing",
    "public",
    "companies",
    `${ticker.trim().toUpperCase()}.md`
  );
}

const THESIS_HEADING_RE = /^##\s+(?:your\s+)?thesis\b.*$/im;
const NEXT_SECTION_RE = /^##\s+/m;
const PLACEHOLDER_LINE_RE =
  /^(?:_?\*?no thesis recorded yet\b.*|_\(your own words\b.*\)_|todo|tbd|n\/a|none|-|\(none\))$/i;

/**
 * Deterministically extracts the user's recorded thesis from a company brain markdown file.
 * Returns `null` when there is no `## Your thesis` / `## Thesis` section or when that section
 * contains only template boilerplate, comments, or whitespace.
 */
export function extractRecordedThesis(markdown: string): string | null {
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const headingMatch = THESIS_HEADING_RE.exec(withoutComments);
  if (!headingMatch) return null;

  const afterHeading = withoutComments.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = NEXT_SECTION_RE.exec(afterHeading);
  const sectionBody = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;

  const meaningfulLines = sectionBody
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .filter((line) => !PLACEHOLDER_LINE_RE.test(line))
    .map((line) =>
      line
        .replace(/^>\s*/, "")
        .trim()
        .replace(/^[_*"'`]+|[_*"'`]+$/g, "")
        .trim()
    )
    .filter((line) => !PLACEHOLDER_LINE_RE.test(line) && /[a-z0-9]/i.test(line));

  if (meaningfulLines.length === 0) return null;
  return meaningfulLines.join("\n");
}

export function inspectTickerThesis(brainRoot: string, rawTicker: string): TickerThesisCoverage {
  const ticker = rawTicker.trim().toUpperCase();
  const filePath = companyBrainPath(brainRoot, ticker);
  if (!fs.existsSync(filePath)) {
    return { ticker, status: "missing_file", hasThesis: false, filePath };
  }
  const content = fs.readFileSync(filePath, "utf8");
  const thesis = extractRecordedThesis(content);
  if (thesis === null) {
    return { ticker, status: "empty_thesis", hasThesis: false, filePath };
  }
  return { ticker, status: "covered", hasThesis: true, filePath };
}

export function evaluateThesisCoverage(brainRoot: string, tickers: string[]): ThesisCoverageReport {
  const uniqueTickers = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].sort();
  const items = uniqueTickers.map((ticker) => inspectTickerThesis(brainRoot, ticker));
  const covered = items.filter((i) => i.status === "covered").map((i) => i.ticker);
  const missingFile = items.filter((i) => i.status === "missing_file").map((i) => i.ticker);
  const emptyThesis = items.filter((i) => i.status === "empty_thesis").map((i) => i.ticker);
  const uncovered = items.filter((i) => !i.hasThesis);

  return {
    total: items.length,
    covered,
    missingFile,
    emptyThesis,
    uncovered,
    items,
  };
}

/**
 * Deterministic `run-check` check for portfolio/watchlist tickers lacking a recorded
 * owner thesis in `<brainRoot>/financial/brain/investing/public/companies/<TICKER>.md`.
 * Skips silently when `brainRoot` itself is missing/unmounted so an unmounted Drive
 * does not masquerade as 15 missing company files.
 */
export function checkThesisCoverageFindings(opts: {
  now: Date;
  brainRoot: string;
  tickers: string[];
}): Finding[] {
  if (opts.tickers.length === 0 || !fs.existsSync(opts.brainRoot)) return [];

  const report = evaluateThesisCoverage(opts.brainRoot, opts.tickers);
  if (report.uncovered.length === 0) return [];

  const parts: string[] = [];
  if (report.missingFile.length > 0) {
    parts.push(`missing brain file: ${report.missingFile.join(", ")}`);
  }
  if (report.emptyThesis.length > 0) {
    parts.push(`empty thesis section: ${report.emptyThesis.join(", ")}`);
  }

  return [
    {
      severity: "warn",
      domain: "financial",
      date: dayString(opts.now),
      code: "missing_thesis",
      message:
        `No recorded thesis for ${report.uncovered.length} of ${report.total} tracked ticker(s) — ` +
        `${parts.join("; ")} (under financial/brain/investing/public/companies/).`,
    },
  ];
}
