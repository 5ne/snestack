import * as path from "path";
import * as fs from "fs";
import type { FundamentalsRow, QuoteRow } from "../../../src/core/db";
import {
  computeTickerDataQuality,
  DEFAULT_DATA_QUALITY_TOLERANCES,
  loadDataQualityTolerances,
  parseDataQualityTolerances,
} from "../../../src/domains/financial/dataQuality";

function makeFundamentals(
  source: "finnhub" | "morningstar",
  overrides: Partial<FundamentalsRow> = {}
): FundamentalsRow {
  return {
    ticker: "DELL",
    as_of_date: "2026-10-15",
    source,
    pe_ratio: 20,
    pb_ratio: 4,
    debt_to_equity: null,
    fcf: null,
    fcf_fiscal_year: null,
    fcf_yield: 0.04,
    fcf_margin: null,
    fcf_positive: 1,
    dividend_yield: 0.015,
    earnings_growth: 0.12,
    revenue_growth: 0.1,
    fair_value: null,
    price_to_fair_value: null,
    economic_moat: null,
    morningstar_rating: null,
    uncertainty: null,
    capital_allocation: null,
    red_flags: null,
    fetched_at: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeQuote(close: number, ticker = "DELL"): QuoteRow {
  return {
    ticker,
    date: "2026-10-28",
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    rsi: 50,
    ma_50: close,
    ma_200: close,
    fetched_at: "2026-10-28T00:00:00.000Z",
  };
}

describe("dataQuality", () => {
  it("parses tolerances from references/quality-bar.md at runtime and honors custom edits", () => {
    const qualityBarPath = path.join(
      __dirname,
      "../../../src/domains/financial/skills/references/quality-bar.md"
    );
    expect(fs.existsSync(qualityBarPath)).toBe(true);
    const loaded = loadDataQualityTolerances(qualityBarPath);
    expect(loaded).toEqual(DEFAULT_DATA_QUALITY_TOLERANCES);

    const tuned = parseDataQualityTolerances(
      "- `growthConflictPctPoints: 25`\n- `morningstarMaxReportAgeDays: 60`\n- `costBasisMaxPriceRatio: 12.5`\n"
    );
    expect(tuned.growthConflictPctPoints).toBe(25);
    expect(tuned.morningstarMaxReportAgeDays).toBe(60);
    expect(tuned.costBasisMaxPriceRatio).toBe(12.5);
    expect(tuned.multipleConflictRelPct).toBe(DEFAULT_DATA_QUALITY_TOLERANCES.multipleConflictRelPct);
  });

  it("flags DELL-style revenue_growth conflict (+49% Finnhub vs -13.6% Morningstar) without picking a winner", () => {
    const dq = computeTickerDataQuality({
      ticker: "dell",
      finnhub: makeFundamentals("finnhub", { revenue_growth: 0.49, pe_ratio: 11.2 }),
      morningstar: makeFundamentals("morningstar", { revenue_growth: -0.136, pe_ratio: 22.4 }),
      now: new Date("2026-10-28T12:00:00Z"),
    });

    expect(dq.ticker).toBe("DELL");
    expect(dq.ok).toBe(false);
    expect(dq.flags).toEqual([
      expect.objectContaining({
        kind: "cross_source_conflict",
        metric: "revenue_growth",
        finnhub: 0.49,
        morningstar: -0.136,
        diffPctPoints: 62.6,
      }),
      expect.objectContaining({
        kind: "cross_source_conflict",
        metric: "pe_ratio",
        finnhub: 11.2,
        morningstar: 22.4,
        diffRelPct: 50,
      }),
    ]);
    expect(dq.flags[0].message).toContain("sources kept separate");
  });

  it("flags stale Morningstar report as_of_date beyond morningstarMaxReportAgeDays", () => {
    const dq = computeTickerDataQuality({
      ticker: "AAPL",
      finnhub: makeFundamentals("finnhub", { ticker: "AAPL" }),
      morningstar: makeFundamentals("morningstar", { ticker: "AAPL", as_of_date: "2026-06-01" }),
      now: new Date("2026-10-28T12:00:00Z"),
    });

    expect(dq.ok).toBe(false);
    expect(dq.flags).toEqual([
      expect.objectContaining({
        kind: "morningstar_stale",
        asOfDate: "2026-06-01",
        maxAgeDays: 90,
      }),
    ]);
  });

  it("flags anomalous held-position cost basis outliers (split/fat-finger or non-positive)", () => {
    const tooHigh = computeTickerDataQuality({
      ticker: "GOOG",
      quote: makeQuote(180, "GOOG"),
      position: { cost_basis: 5 }, // 36x > 20x
      now: new Date("2026-10-28T12:00:00Z"),
    });
    expect(tooHigh.ok).toBe(false);
    expect(tooHigh.flags[0]).toMatchObject({
      kind: "anomalous_cost_basis",
      costBasis: 5,
      price: 180,
      priceToCostRatio: 36,
    });

    const tooLow = computeTickerDataQuality({
      ticker: "GOOG",
      quote: makeQuote(180, "GOOG"),
      position: { cost_basis: 2500 }, // 0.072x < 0.1x (e.g. pre-20:1-split basis)
      now: new Date("2026-10-28T12:00:00Z"),
    });
    expect(tooLow.ok).toBe(false);
    expect(tooLow.flags[0]).toMatchObject({
      kind: "anomalous_cost_basis",
      costBasis: 2500,
      price: 180,
      priceToCostRatio: 0.07,
    });
  });

  it("returns ok: true with empty flags when metrics agree within tolerance and report is fresh", () => {
    const dq = computeTickerDataQuality({
      ticker: "MSFT",
      finnhub: makeFundamentals("finnhub", { ticker: "MSFT", revenue_growth: 0.16, pe_ratio: 31 }),
      morningstar: makeFundamentals("morningstar", {
        ticker: "MSFT",
        as_of_date: "2026-10-10",
        revenue_growth: 0.14,
        pe_ratio: 29,
      }),
      quote: makeQuote(420, "MSFT"),
      position: { cost_basis: 373.9 },
      now: new Date("2026-10-28T12:00:00Z"),
    });
    expect(dq).toEqual({ ticker: "MSFT", ok: true, flags: [] });
  });
});
