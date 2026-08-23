# Skill: Long-Term Quality Investing

**Purpose:** judge whether to open, hold, add to, or exit a long-term position based on durable business quality and an intact growth thesis — not short-term price action. This is the default lens for this system; it's how the user has actually invested so far (multi-year accumulation in AAPL on product growth, held AMZN through the pandemic, held META since the 2010s on platform growth, NVDA on the AI theme — see the individual brain files for the exact notes).

**Parameters:** `ticker` (required)

## Inputs to gather before judging

1. Fundamentals via the Morningstar report (`EquityAgent` / `morningstarParser.ts`): fair value, price-to-fair-value, economic moat, star rating, uncertainty, capital allocation grade, P/E, P/B, debt/equity, FCF, FCF yield, dividend yield, earnings growth, revenue growth, and any detected red flags.
2. Price/technical snapshot (`QuoteAgent`): current price, RSI-14, 50-day MA, 200-day MA.
3. This ticker's brain file (`brain/investing/public/companies/{TICKER}.md`) — the user's own stated thesis (quoted verbatim there) and the history of past calls on this name.
4. `skills/references/quality-bar.md` for the current numeric defaults — read it fresh each time rather than hardcoding numbers here, since the user tunes it directly.

## Judgment process

1. **Is the growth thesis still intact?** Compare what's happening now against the thesis quoted in the brain file (a structural growth story: product expansion, platform network effects, a secular tailwind like AI or cloud). Has anything actually happened to break it, or is this just short-term noise?
2. **Is the business durably profitable?** Check FCF, margin trend, and Morningstar's moat rating against `quality-bar.md`'s long-term bar.
3. **Is the revenue/earnings trajectory still growing, or has it turned structurally negative?** A single soft quarter is not disqualifying. Multiple consecutive quarters of decline is.
4. **Valuation sanity check.** Morningstar's price-to-fair-value is a secondary input here — a rich valuation on a name whose thesis is intact argues against adding *more* right now, not against continuing to hold.
5. **Add-on timing.** If steps 1–4 still hold, treat RSI under the threshold in `quality-bar.md` (draft: ~35–40) as a signal that this is a reasonable moment to add to the position. A *high* RSI on an intact-thesis name is a reason to hold off on new buys, not a reason to sell — this strategy does not sell on technical strength.
6. **Exit/trim triggers.** Only on thesis break: moat erosion, sustained (multi-quarter) profitability deterioration, or a structural change to the growth story described in step 1. Short-term technical weakness (a death cross, a low RSI, a red day) is explicitly **not** a sell signal under this strategy on its own — that's a different strategy (see below).

## Output

A recommendation for this ticker under the long-term strategy — BUY-more / HOLD / TRIM / SELL — with one paragraph of reasoning tracing back to steps 1–6, and a note on whether this changes anything in the ticker's brain file (a thesis update, a new red flag worth recording).

## Relationship to swing-trading-large-cap.md

This skill and the swing-trading skill can both apply to the same ticker at once (e.g., NVDA can carry a long-term core position under this skill *and* separate tactical swing trades under the other). They read the *same* RSI number and act on it in opposite directions for different reasons — that's intentional, not a bug. Report their conclusions separately; never let a swing-trade SELL signal get merged into or override a long-term HOLD conclusion on the same ticker.
