import * as fs from "fs";
import * as path from "path";
import type { Db, FundamentalsRow, PositionRow, QuoteRow } from "../../core/db";
import { resolveTickerUniverse } from "./cliHelpers";

export interface DataQualityTolerances {
  /** Max allowed spread in percentage points between Finnhub and Morningstar growth rates (e.g. 15 = 15pp = 0.15). */
  growthConflictPctPoints: number;
  /** Max allowed spread in percentage points between Finnhub and Morningstar yield metrics (e.g. 2 = 2pp = 0.02). */
  yieldConflictPctPoints: number;
  /** Max allowed relative % difference between Finnhub and Morningstar valuation/leverage multiples (e.g. 35 = 35%). */
  multipleConflictRelPct: number;
  /** Max age in days for Morningstar `as_of_date` before flagging the report as stale. */
  morningstarMaxReportAgeDays: number;
  /** Lower bound on `price / cost_basis` for held positions before flagging a potential split/entry anomaly. */
  costBasisMinPriceRatio: number;
  /** Upper bound on `price / cost_basis` for held positions before flagging a potential split/entry anomaly. */
  costBasisMaxPriceRatio: number;
}

export const DEFAULT_DATA_QUALITY_TOLERANCES: DataQualityTolerances = {
  growthConflictPctPoints: 15,
  yieldConflictPctPoints: 2,
  multipleConflictRelPct: 35,
  morningstarMaxReportAgeDays: 90,
  costBasisMinPriceRatio: 0.1,
  costBasisMaxPriceRatio: 20,
};

export type SharedMetricName =
  | "revenue_growth"
  | "earnings_growth"
  | "fcf_yield"
  | "dividend_yield"
  | "pe_ratio"
  | "pb_ratio"
  | "debt_to_equity";

export type DataQualityFlag =
  | {
      kind: "cross_source_conflict";
      metric: SharedMetricName;
      finnhub: number;
      morningstar: number;
      diffPctPoints?: number;
      diffRelPct?: number;
      message: string;
    }
  | {
      kind: "morningstar_stale";
      asOfDate: string;
      ageDays: number;
      maxAgeDays: number;
      message: string;
    }
  | {
      kind: "anomalous_cost_basis";
      costBasis: number;
      price: number | null;
      priceToCostRatio: number | null;
      message: string;
    };

export interface TickerDataQuality {
  ticker: string;
  ok: boolean;
  flags: DataQualityFlag[];
}

export interface UniverseDataQualityReport {
  total: number;
  clean: string[];
  flagged: TickerDataQuality[];
  tolerances: DataQualityTolerances;
}

const TOLERANCE_KEYS: Array<keyof DataQualityTolerances> = [
  "growthConflictPctPoints",
  "yieldConflictPctPoints",
  "multipleConflictRelPct",
  "morningstarMaxReportAgeDays",
  "costBasisMinPriceRatio",
  "costBasisMaxPriceRatio",
];

export function defaultQualityBarPath(): string {
  // Works both from compiled dist/ (resolve via cwd/src/...) and from ts-jest under src/
  const fromCwd = path.join(process.cwd(), "src", "domains", "financial", "skills", "references", "quality-bar.md");
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.join(__dirname, "skills", "references", "quality-bar.md");
}

/**
 * Parse owner-tunable data-quality tolerances out of `references/quality-bar.md` at runtime
 * (per financial `vision.md` Non-Negotiable #3: thresholds live in `quality-bar.md`, not code).
 */
export function parseDataQualityTolerances(markdown: string): DataQualityTolerances {
  const result: DataQualityTolerances = { ...DEFAULT_DATA_QUALITY_TOLERANCES };
  for (const key of TOLERANCE_KEYS) {
    const re = new RegExp(`\\b${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, "i");
    const match = re.exec(markdown);
    if (match) {
      const num = Number(match[1]);
      if (Number.isFinite(num) && num > 0) {
        result[key] = num;
      }
    }
  }
  return result;
}

export function loadDataQualityTolerances(qualityBarPath = defaultQualityBarPath()): DataQualityTolerances {
  if (!fs.existsSync(qualityBarPath)) {
    return { ...DEFAULT_DATA_QUALITY_TOLERANCES };
  }
  return parseDataQualityTolerances(fs.readFileSync(qualityBarPath, "utf8"));
}

function fmtSignedPct(decimalVal: number): string {
  const pct = decimalVal * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function fmtNum(val: number): string {
  return Number.isInteger(val) ? String(val) : val.toFixed(2);
}

/**
 * Deterministically computes cross-source conflicts, Morningstar report staleness,
 * and cost-basis anomalies for a single ticker from cached rows. Never reconciles or
 * picks a winner between Finnhub and Morningstar (vision.md Non-Negotiable #4).
 */
export function computeTickerDataQuality(opts: {
  ticker: string;
  finnhub?: FundamentalsRow | null;
  morningstar?: FundamentalsRow | null;
  quote?: QuoteRow | null;
  position?: Pick<PositionRow, "cost_basis"> | null;
  tolerances?: DataQualityTolerances;
  now?: Date;
}): TickerDataQuality {
  const ticker = opts.ticker.trim().toUpperCase();
  const tolerances = opts.tolerances ?? DEFAULT_DATA_QUALITY_TOLERANCES;
  const now = opts.now ?? new Date();
  const flags: DataQualityFlag[] = [];

  const fh = opts.finnhub ?? null;
  const ms = opts.morningstar ?? null;

  if (fh && ms) {
    const pctPointMetrics: Array<{ key: "revenue_growth" | "earnings_growth" | "fcf_yield" | "dividend_yield"; maxPp: number }> = [
      { key: "revenue_growth", maxPp: tolerances.growthConflictPctPoints },
      { key: "earnings_growth", maxPp: tolerances.growthConflictPctPoints },
      { key: "fcf_yield", maxPp: tolerances.yieldConflictPctPoints },
      { key: "dividend_yield", maxPp: tolerances.yieldConflictPctPoints },
    ];

    for (const { key, maxPp } of pctPointMetrics) {
      const fVal = fh[key];
      const mVal = ms[key];
      if (fVal == null || mVal == null) continue;
      const diffPctPoints = Number((Math.abs(fVal - mVal) * 100).toFixed(1));
      if (diffPctPoints > maxPp) {
        flags.push({
          kind: "cross_source_conflict",
          metric: key,
          finnhub: fVal,
          morningstar: mVal,
          diffPctPoints,
          message:
            `${key} differs by ${diffPctPoints.toFixed(1)}pp across sources ` +
            `(Finnhub ${fmtSignedPct(fVal)} vs. Morningstar ${fmtSignedPct(mVal)}; tolerance ${maxPp}pp) — ` +
            `sources kept separate, check report period.`,
        });
      }
    }

    const multipleMetrics: Array<"pe_ratio" | "pb_ratio" | "debt_to_equity"> = [
      "pe_ratio",
      "pb_ratio",
      "debt_to_equity",
    ];
    for (const key of multipleMetrics) {
      const fVal = fh[key];
      const mVal = ms[key];
      if (fVal == null || mVal == null) continue;
      const denom = Math.max(Math.abs(fVal), Math.abs(mVal));
      if (denom === 0) continue;
      const diffRelPct = Number(((Math.abs(fVal - mVal) / denom) * 100).toFixed(1));
      if (diffRelPct > tolerances.multipleConflictRelPct) {
        flags.push({
          kind: "cross_source_conflict",
          metric: key,
          finnhub: fVal,
          morningstar: mVal,
          diffRelPct,
          message:
            `${key} differs by ${diffRelPct.toFixed(1)}% across sources ` +
            `(Finnhub ${fmtNum(fVal)} vs. Morningstar ${fmtNum(mVal)}; tolerance ${tolerances.multipleConflictRelPct}%) — ` +
            `sources kept separate.`,
        });
      }
    }
  }

  if (ms?.as_of_date) {
    const parsedMs = Date.parse(`${ms.as_of_date}T00:00:00Z`);
    if (!Number.isNaN(parsedMs)) {
      const ageDays = Math.floor((now.getTime() - parsedMs) / 86_400_000);
      if (ageDays > tolerances.morningstarMaxReportAgeDays) {
        flags.push({
          kind: "morningstar_stale",
          asOfDate: ms.as_of_date,
          ageDays,
          maxAgeDays: tolerances.morningstarMaxReportAgeDays,
          message:
            `Morningstar report as_of_date (${ms.as_of_date}) is ${ageDays}d old ` +
            `(>${tolerances.morningstarMaxReportAgeDays}d limit) — re-pull PDF if newer coverage exists.`,
        });
      }
    }
  }

  if (opts.position && opts.position.cost_basis != null) {
    const costBasis = opts.position.cost_basis;
    const price = opts.quote?.close ?? null;
    if (costBasis <= 0) {
      flags.push({
        kind: "anomalous_cost_basis",
        costBasis,
        price,
        priceToCostRatio: null,
        message: `Recorded position cost_basis (${costBasis}) is non-positive — verify entry record.`,
      });
    } else if (price != null && price > 0) {
      const ratio = price / costBasis;
      if (ratio < tolerances.costBasisMinPriceRatio || ratio > tolerances.costBasisMaxPriceRatio) {
        const rounded = Number(ratio.toFixed(2));
        flags.push({
          kind: "anomalous_cost_basis",
          costBasis,
          price,
          priceToCostRatio: rounded,
          message:
            `Price ($${fmtNum(price)}) is ${rounded}x recorded cost_basis ($${fmtNum(costBasis)}), ` +
            `outside [${tolerances.costBasisMinPriceRatio}x, ${tolerances.costBasisMaxPriceRatio}x] — ` +
            `verify split adjustment or entry price.`,
        });
      }
    }
  }

  return { ticker, ok: flags.length === 0, flags };
}

export async function loadTickerDataQualityFromDb(
  db: Db,
  rawTicker: string,
  tolerances = loadDataQualityTolerances(),
  now = new Date()
): Promise<TickerDataQuality> {
  const ticker = rawTicker.trim().toUpperCase();
  const [finnhub, morningstar, quote, position] = await Promise.all([
    db.getLatestFundamentals(ticker, "finnhub"),
    db.getLatestFundamentals(ticker, "morningstar"),
    db.getLatestQuote(ticker),
    db.getPosition(ticker),
  ]);
  return computeTickerDataQuality({ ticker, finnhub, morningstar, quote, position, tolerances, now });
}

export async function loadUniverseDataQualityFromDb(
  db: Db,
  tolerances = loadDataQualityTolerances(),
  now = new Date()
): Promise<UniverseDataQualityReport> {
  const tickers = (await resolveTickerUniverse(db)).sort();
  const results = await Promise.all(tickers.map((t) => loadTickerDataQualityFromDb(db, t, tolerances, now)));
  return {
    total: results.length,
    clean: results.filter((r) => r.ok).map((r) => r.ticker),
    flagged: results.filter((r) => !r.ok),
    tolerances,
  };
}
