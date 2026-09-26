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
