---
name: buffett-value
domain: financial
requires: [quote, fundamentals, brain]
model: normal
references: [quality-bar, buffett-playbook]
# Patient Omaha owner-operator cadence, distinct from swing-trading (hourly RSI extremes)
# and long-term-quality (weekly growth-thesis check with rsiAbove: 70):
# - Never re-triggers merely because RSI rose above 70 (Buffett does not sell wonderful
#   businesses on overbought technicals).
# - Runs when Mr. Market offers a fat-pitch pullback (rsiBelow: 38 with minRsiMoveToRerun: 5),
#   when price moves 8%+ (materially shifting price-to-fair-value / margin of safety),
#   when a Morningstar report or brain thesis file updates, or on a 14-day owner check-in.
gate:
  rsiBelow: 38
  minRsiMoveToRerun: 5
  priceMovePct: 8
  maxAgeDays: 14
  inputsUpdated: true
verdict: true
---

# Skill: Warren Buffett Intrinsic-Value & Compounder Strategy

**Purpose:** evaluate a ticker as a standalone **third strategy** (`[Buffett]`) alongside `long-term-quality.md` (`[Long-term]`, your medium/long-term growth-thesis lens) and `swing-trading-large-cap.md` (`[Swing]`, short-term RSI mean-reversion). Grounded in *The Essays of Warren Buffett: Lessons for Corporate America* (ed. Lawrence A. Cunningham) and *The Warren Buffett Way* (Robert G. Hagstrom, blending Benjamin Graham's *Intelligent Investor* Ch. 8 & 20 with Philip Fisher), this strategy asks a stricter owner-operator question: *if the stock market closed for 10 years tomorrow, does this business possess a durable economic moat, real cash owner earnings, a fortress balance sheet, candid & disciplined capital allocation, and an uncertainty-adjusted margin of safety at Mr. Market's current price?*

**Parameters:** `ticker` (required)

## Inputs to gather before judging

1. Fundamentals via Morningstar (`FUNDAMENTALS` / `EquityAgent`): `fairValue`, `priceToFairValue`, `economicMoat`, `morningstarRating`, `uncertainty`, `capitalAllocation`, `peRatio`, `pbRatio`, `debtToEquity`, `fcf`, `fcfFiscalYear`, `fcfYield`, `dividendYield`, `earningsGrowth`, `revenueGrowth`, and `redFlags`.
2. Market & live fundamental snapshot (`QUOTE` / `QuoteAgent`): `price`, `rsi` (RSI-14), `ma50`, `ma200`, plus Finnhub's independent `peRatio`, `pbRatio`, `debtToEquity`, `fcfYield`, `fcfMargin`, `fcfPositive`, `earningsGrowth`, and `revenueGrowth`.
3. This ticker's brain file (`BRAIN` — `brain/investing/public/companies/{TICKER}.md`): the owner's stated thesis under `## Your thesis`, position vs. watchlist status, and dated history/notes.
4. `references/quality-bar.md` (`## Buffett value bar (buffett-value.md)`) and `references/buffett-playbook.md` — read both fresh each run rather than hardcoding cutoffs.

## Judgment process

1. **Circle of competence & owner thesis (`BRAIN`).** Check `BRAIN` to confirm whether this is a held position or a watchlist candidate, and read the owner's thesis. Is this an understandable operating business whose unit economics can be reasonably judged 5–10 years out? Non-operating vehicles (e.g. pre-deal SPAC trust baskets) or speculative pre-profit stories with `"None"` moat and `"Very High"` uncertainty fall outside the Buffett circle of competence. If no owner thesis is recorded, state that explicitly and temper confidence rather than inventing one.
2. **The Castle & the Moat (`economicMoat`).** Require clear evidence of durable competitive advantage (`"Wide"` or strong `"Narrow"` moat — switching costs, network effects, intangible brand/regulatory assets, or structural cost scale) per `quality-bar.md` and `buffett-playbook.md`. Ask whether the moat and pricing power are widening, steady, or being eroded by competitors or technology shifts.
3. **Owner Earnings over GAAP Optics (`fcf`, `fcfMargin`, `fcfYield`, `fcfPositive` vs. `earningsGrowth`).** Evaluate real cash left after maintenance capex rather than headline EPS alone. Persistent negative FCF or rising GAAP earnings paired with shrinking cash conversion fails the Buffett owner-earnings bar. When Finnhub (`QUOTE`) and Morningstar (`FUNDAMENTALS`) diverge materially on growth or multiples, note both numbers plainly rather than averaging them.
4. **Balance-Sheet Fortress (`debtToEquity`).** Check leverage against `quality-bar.md`'s Buffett value bar. Great compounders earn high cash returns without fragile debt loads that could turn an industry downturn into permanent capital loss.
5. **Management & Capital Allocation (`capitalAllocation`).** Weigh Morningstar's `capitalAllocation` grade (`"Exemplary"` / `"Standard"` / `"Poor"`). Over a decade, management deploys the majority of retained capital; `"Exemplary"` allocators reinforce `BUY`/`HOLD` conviction, whereas `"Poor"` capital allocation is a major red flag against committing or keeping capital.
6. **Intrinsic Value & Uncertainty-Tiered Margin of Safety (`priceToFairValue`, `fairValue`, `uncertainty`, `morningstarRating`).** Unlike `long-term-quality.md` (where valuation is secondary to an intact growth story), **margin of safety is a first-class gate here**:
   - Recommend **`BUY`** only when the business clears steps 1–5 *and* `priceToFairValue` meets `quality-bar.md`'s uncertainty-tiered Buffett entry bar ("wonderful company at a fair-to-discounted price").
   - For a **held position** in an intact compounder trading modestly above fair value, recommend **`HOLD`** ("lethargy bordering on sloth" — pause adds, let intrinsic value compound).
   - For an **un-owned watchlist ticker** that either fails the Buffett business/moat/profitability bar or trades above `quality-bar.md`'s required margin of safety with nothing actionable to do today, return **`NONE`** so quiet "wait for a fat pitch" watchlist checks stay out of the signal email.
7. **Exit/trim discipline (`SELL`).** For held positions, recommend `SELL` (or trim) only when: (a) the economic moat or owner thesis is structurally impaired, (b) owner earnings, balance-sheet safety, or `capitalAllocation` (`"Poor"`) deteriorate across multiple quarters, or (c) market price detaches past `quality-bar.md`'s extreme-valuation guardrail where prospective multi-year owner returns are severely compressed. Short-term technical weakness (low RSI, death cross, red week) is **never** a sell signal; Mr. Market's pessimism on an intact business is an opportunity, not an instruction.

## Output

A clear Omaha owner-operator assessment under the `[Buffett]` strategy — BUY / HOLD / SELL (or no-action `NONE` on an unactionable watchlist name) — in one grounded paragraph citing moat durability, owner earnings & debt safety, capital allocation, and `priceToFairValue` margin of safety relative to `uncertainty`.

**Final line (required, machine-read by automation):** end the response with exactly one line, in plain text with no markdown formatting:

`VERDICT: <BUY|SELL|HOLD|NONE> | <confidence 0.00-1.00> | <one or two sentences of reasoning>`

Use `BUY` for a moat-protected compounder meeting the margin-of-safety bar, `HOLD` for an intact held business worth keeping without adding at today's price, `SELL` for structural moat/capital-allocation impairment or extreme valuation detachment, and `NONE` when a watchlist ticker fails the Buffett circle-of-competence/moat filter or lacks a margin-of-safety pitch today.

## Relationship to long-term-quality.md and swing-trading-large-cap.md

All three strategies run independently and carry distinct prefixes (`[Buffett]`, `[Long-term]`, `[Swing]`):
- `long-term-quality.md` (`[Long-term]`) judges your secular growth thesis where valuation is secondary — it may say `BUY` or `HOLD` on a high-growth name whose `priceToFairValue` or `uncertainty` keeps `buffett-value.md` (`[Buffett]`) on the sidelines.
- `swing-trading-large-cap.md` (`[Swing]`) trades short-term RSI overbought/oversold swings mechanically.
Disagreement across the three lenses is expected and informative — never merge or override another strategy's call.
