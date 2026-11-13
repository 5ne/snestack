import * as fs from "fs";
import * as path from "path";
import { dayString, type Finding } from "../../core/runCheck";

export type ThesisStatus = "covered" | "missing_file" | "empty_thesis";

export type BuffettResearchAreaId =
  | "circle_of_competence"
  | "economic_moat"
  | "owner_earnings_and_fortress"
  | "management_capital_allocation"
  | "margin_of_safety_and_kill_criteria";

export interface BuffettResearchArea {
  area: BuffettResearchAreaId;
  title: string;
  whatBuffettWouldDo: string;
}

export interface TickerThesisCoverage {
  ticker: string;
  status: ThesisStatus;
  hasThesis: boolean;
  filePath: string;
  researchAreas: BuffettResearchArea[];
}

export interface ThesisCoverageReport {
  total: number;
  covered: string[];
  missingFile: string[];
  emptyThesis: string[];
  uncovered: TickerThesisCoverage[];
  items: TickerThesisCoverage[];
}

/**
 * Deterministic "What Would Buffett Do" research agenda for any ticker that lacks
 * a recorded owner thesis. Suggests the five areas an owner-operator investigates
 * before writing a thesis in `brain/investing/public/companies/<TICKER>.md` —
 * without ever writing to the user's brain file on their behalf.
 */
export function buildBuffettResearchAreas(rawTicker: string): BuffettResearchArea[] {
  const ticker = rawTicker.trim().toUpperCase();
  return [
    {
      area: "circle_of_competence",
      title: "Circle of Competence & 10-Year Predictability",
      whatBuffettWouldDo:
        `Read ${ticker}'s latest 10-K Item 1 (Business) and shareholder letter: explain in plain English ` +
        `how a customer pays, why they stay, and whether industry unit economics are predictable 10 years out.`,
    },
    {
      area: "economic_moat",
      title: "Economic Moat & Pricing Power",
      whatBuffettWouldDo:
        `Identify ${ticker}'s durable moat source (switching costs, network effects, intangible brand/IP, or ` +
        `structural cost advantage) and run the 10% pricing-power test — could it raise prices without losing customers?`,
    },
    {
      area: "owner_earnings_and_fortress",
      title: "Owner Earnings & Balance-Sheet Fortress",
      whatBuffettWouldDo:
        `Compare ${ticker}'s 5-year free cash flow (after maintenance capex and SBC dilution) against GAAP net income, ` +
        `and check that long-term debt can be retired in under 3–4 years of normalized owner earnings.`,
    },
    {
      area: "management_capital_allocation",
      title: "Management Candor & Capital Allocation",
      whatBuffettWouldDo:
        `Audit 5 years of ${ticker}'s retained-earnings deployment (returns on incremental invested capital, ` +
        `disciplined vs. empire-building M&A, and share buybacks below vs. above intrinsic value) plus candor in shareholder letters.`,
    },
    {
      area: "margin_of_safety_and_kill_criteria",
      title: "Intrinsic Value, Margin of Safety & Kill Criteria",
      whatBuffettWouldDo:
        `Estimate conservative discounted owner earnings vs. ${ticker}'s market cap, set your required margin of safety, ` +
        `and write down the 1–2 structural moat-impairment events that would make you sell regardless of price.`,
    },
  ];
}

export function buffettResearchBrief(rawTicker: string): string {
  const ticker = rawTicker.trim().toUpperCase();
  return (
    `research ${ticker} across the 5 Buffett owner pillars: ` +
    `(1) 10-K business model & 10yr predictability, ` +
    `(2) economic moat & pricing power, ` +
    `(3) 5yr owner earnings/FCF vs. GAAP & debt payoff, ` +
    `(4) management candor & capital allocation, ` +
    `(5) intrinsic value margin of safety & thesis-break criteria`
  );
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

export function hasRecordedThesisFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  return extractRecordedThesis(fs.readFileSync(filePath, "utf8")) !== null;
}

export function inspectTickerThesis(brainRoot: string, rawTicker: string): TickerThesisCoverage {
  const ticker = rawTicker.trim().toUpperCase();
  const filePath = companyBrainPath(brainRoot, ticker);
  if (!fs.existsSync(filePath)) {
    return {
      ticker,
      status: "missing_file",
      hasThesis: false,
      filePath,
      researchAreas: buildBuffettResearchAreas(ticker),
    };
  }
  const content = fs.readFileSync(filePath, "utf8");
  const thesis = extractRecordedThesis(content);
  if (thesis === null) {
    return {
      ticker,
      status: "empty_thesis",
      hasThesis: false,
      filePath,
      researchAreas: buildBuffettResearchAreas(ticker),
    };
  }
  return { ticker, status: "covered", hasThesis: true, filePath, researchAreas: [] };
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
        `${parts.join("; ")} (under financial/brain/investing/public/companies/). ` +
        `Suggested Buffett research per uncovered ticker: 10-K business model & 10yr predictability, ` +
        `economic moat & pricing power, 5yr owner earnings (FCF vs. GAAP) & debt payoff, ` +
        `management capital allocation, and margin of safety.`,
    },
  ];
}
