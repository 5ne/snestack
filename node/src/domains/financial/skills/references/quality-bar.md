---
name: quality-bar
domain: financial
type: reference
---

# Quality & Eligibility Defaults (draft — tune these)

These are starting defaults, not numbers you specified — you asked for reasonable drafts to react to once you see them applied to your actual holdings. Edit this file directly; `long-term-quality.md`, `swing-trading-large-cap.md`, and `buffett-value.md` all read from it, so tuning happens in one place.

## Long-term quality bar (long-term-quality.md)

- Free cash flow: positive, ideally growing.
- Revenue/earnings growth: not structurally declining. A single soft quarter isn't disqualifying; multiple consecutive quarters of decline is a red flag.
- Moat: Morningstar "narrow" or "wide" preferred. "None" is a caution flag, not an automatic disqualifier if other quality signals are strong.
- Valuation: Morningstar price-to-fair-value is a secondary check only — used to size conviction on new adds, not to trigger exits on an intact thesis.

## Swing-trading eligibility (swing-trading-large-cap.md)

- Market cap: large-cap or mega-cap only (draft cutoff: >$50B — adjust freely).
- Profitability: consistently profitable — positive FCF over the trailing year, not a turnaround/recovery story.
- Excludes: pre-profitability names (e.g. RIVN today), and anything carrying a "very high" Morningstar uncertainty rating.

## Buffett value bar (buffett-value.md)

- **Economic moat:** Morningstar `"Wide"` strongly preferred; `"Narrow"` acceptable when paired with durable switching costs/cost scale and strong cash conversion. `"None"` fails the Buffett compounding bar for new `BUY` calls unless backed by an extraordinary asset/cash discount.
- **Owner earnings / Free cash flow:** consistently positive (`fcfPositive: true`), with durable cash conversion (draft guidepost: `fcfMargin` >= ~12–15% for asset-light compounders, `fcfYield` >= ~3% or growing steadily; GAAP earnings rising while FCF shrinks is a warning flag).
- **Balance-sheet fortress (`debtToEquity`):** conservative leverage required (draft ceiling: `debtToEquity` <= ~1.0 preferred; > ~1.5 is a caution flag, especially alongside cyclical cash flows or `"High"`/`"Very High"` uncertainty).
- **Capital allocation:** Morningstar `"Exemplary"` or `"Standard"` required for new `BUY` calls. `"Poor"` capital allocation blocks new buys and is a candidate exit/trim factor on held positions.
- **Intrinsic value & Margin of Safety (`priceToFairValue`, first-class requirement):**
  - `"Wide"` moat + `"Low"`/`"Medium"` uncertainty ("wonderful business at a fair price"): eligible for `BUY` up to fair value (draft: `priceToFairValue` <= ~1.00).
  - `"Narrow"` moat or `"High"` uncertainty: require a clear margin of safety before `BUY` (draft: `priceToFairValue` <= ~0.85).
  - `"Very High"` uncertainty: normally ineligible for Buffett `BUY` unless deep discount (`priceToFairValue` <= ~0.70) *and* explicit owner thesis conviction; un-owned watchlist names with `"None"` moat + `"Very High"` uncertainty return `NONE`.
  - **Hold vs. extreme-valuation trim:** intact held compounders trading above fair value (`priceToFairValue` ~1.05–1.50) are a patient `HOLD`, *not* a sell. Only flag valuation-driven `SELL`/trim consideration on extreme detachment (draft guardrail: `priceToFairValue` > ~1.60 alongside stretched multiples) where 10-year owner returns are severely compressed.

## RSI thresholds (used across strategies for different purposes)

- Long-term add-on trigger: RSI under ~35–40, and *only* when the quality bar above still holds. A stretched RSI on a name with an intact thesis is a reason to pause new buys, not a reason to sell.
- Buffett fat-pitch check: RSI under ~38 (or a meaningful price pullback bringing `priceToFairValue` inside the margin-of-safety tier above), *only* when moat, owner earnings, debt, and capital allocation pass. Overbought RSI is ignored completely under `buffett-value.md`.
- Swing-trade buy: RSI under ~30 (oversold).
- Swing-trade sell/trim: RSI over ~70 (overbought).

## Still open — revisit with the user

- Exact market-cap cutoff and margin/FCF-yield numbers (currently rough drafts).
- Swing-trade hold-time expectation before a forced reassessment.
- Whether "declining for N consecutive quarters" should be 2, 3, or something else.
