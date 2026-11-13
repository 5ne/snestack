---
name: quality-bar
domain: financial
type: reference
---

# Quality & Eligibility Defaults (draft — tune these)

These are starting defaults, not numbers you specified — you asked for reasonable drafts to react to once you see them applied to your actual holdings. Edit this file directly; both `long-term-quality.md` and `swing-trading-large-cap.md` read from it, so tuning happens in one place.

## Long-term quality bar (long-term-quality.md)

- Free cash flow: positive, ideally growing.
- Revenue/earnings growth: not structurally declining. A single soft quarter isn't disqualifying; multiple consecutive quarters of decline is a red flag.
- Moat: Morningstar "narrow" or "wide" preferred. "None" is a caution flag, not an automatic disqualifier if other quality signals are strong.
- Valuation: Morningstar price-to-fair-value is a secondary check only — used to size conviction on new adds, not to trigger exits on an intact thesis.

## Swing-trading eligibility (swing-trading-large-cap.md)

- Market cap: large-cap or mega-cap only (draft cutoff: >$50B — adjust freely).
- Profitability: consistently profitable — positive FCF over the trailing year, not a turnaround/recovery story.
- Excludes: pre-profitability names (e.g. RIVN today), and anything carrying a "very high" Morningstar uncertainty rating.

## RSI thresholds (both skills use RSI, in opposite directions, for different purposes)

- Long-term add-on trigger: RSI under ~35–40, and *only* when the quality bar above still holds. A stretched RSI on a name with an intact thesis is a reason to pause new buys, not a reason to sell.
- Swing-trade buy: RSI under ~30 (oversold).
- Swing-trade sell/trim: RSI over ~70 (overbought).

## Still open — revisit with the user

- Exact market-cap cutoff and margin/FCF-yield numbers (currently rough drafts).
- Swing-trade hold-time expectation before a forced reassessment.
- Whether "declining for N consecutive quarters" should be 2, 3, or something else.
- Exact `data_quality` conflict/staleness tolerances below once seen against live holdings.

## Data-quality tolerances (draft — tune these)

Read deterministically at runtime by `data-dump` and `contextTools["data-quality"]` so cross-source disagreements, stale Morningstar PDFs, and anomalous cost bases are flagged once instead of re-derived in every verdict (Finnhub and Morningstar stay separate — flags report disagreement and never pick a winner):

- `growthConflictPctPoints: 15` — flag `revenue_growth` or `earnings_growth` when Finnhub and Morningstar differ by more than 15 percentage points (0.15).
- `yieldConflictPctPoints: 2` — flag `fcf_yield` or `dividend_yield` when Finnhub and Morningstar differ by more than 2 percentage points (0.02).
- `multipleConflictRelPct: 35` — flag `pe_ratio`, `pb_ratio`, or `debt_to_equity` when Finnhub and Morningstar differ by more than 35% relative to the larger multiple.
- `morningstarMaxReportAgeDays: 90` — flag Morningstar `as_of_date` older than 90 days as a stale PDF report.
- `costBasisMinPriceRatio: 0.1` — flag held position `price / cost_basis` below 0.1x (or `cost_basis <= 0`) as a likely split or entry anomaly.
- `costBasisMaxPriceRatio: 20` — flag held position `price / cost_basis` above 20x as a likely split or entry anomaly to verify.
