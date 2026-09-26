---
name: swing-trading-large-cap
domain: financial
requires: [quote, fundamentals, brain]
references: [quality-bar]
---

# Skill: Swing Trading (Large-Cap, Highly Profitable Only)

**Purpose:** tactically trade short-term overbought/oversold swings — buy into weakness, sell into strength — on a strictly filtered set of large-cap, highly profitable names. This strategy deliberately ignores long-term thesis quality beyond the eligibility bar below; it's playing price mean-reversion on the sturdiest names in the universe, not making an investment case.

**Parameters:** `ticker` (required)

## Eligibility filter — must ALL pass before anything else runs

See `skills/references/quality-bar.md` for the current numeric defaults. As of the last draft:
- Market cap: large-cap or mega-cap only.
- Profitability: consistently profitable, positive trailing FCF — not a turnaround or recovery story.
- Excludes: pre-profitability names and anything with a "very high" Morningstar uncertainty rating (e.g. RIVN fails this filter today — no swing trades on RIVN under this strategy regardless of what its RSI does).

If a ticker fails this filter, stop here — it doesn't get a swing trade recommendation under this strategy, full stop, regardless of technicals.

## Judgment process (for names that pass the filter)

1. Confirm eligibility (above) using the ticker's brain file and latest fundamentals.
2. Check RSI-14 (`QuoteAgent`): buy signal when oversold (under the threshold in `quality-bar.md`, draft ~30), sell/trim signal when overbought (over the threshold, draft ~70). This step is deliberately mechanical and short-horizon — don't re-litigate the fundamental case each time, that's the other skill's job.
3. Size the trade separately from any long-term core position in the same name (see the gap noted below — the database doesn't yet support this distinction).
4. Exit discipline: a swing position is meant to close on the reversion (RSI crossing back through neutral), not sit indefinitely. If it's still open after some reasonable window, flag it for reassessment rather than letting it drift into a de-facto long-term hold — exact window still TBD with the user.

## Output

A tactical BUY / SELL / no-action call for this ticker, clearly labeled as a swing-trade recommendation (not a long-term one), with the RSI level and eligibility check cited.

## Relationship to long-term-quality.md

Can run on the same ticker as the long-term skill — see that file's "Relationship" section. Report the two conclusions separately.

## Known gap — partially fixed 2026-08-23

`positions` now has a `strategy` column (`long-term` / `swing` / `both`), set via `snestack position add --strategy` or `snestack position strategy <ticker> <strategy>`, so a ticker's dominant strategy is at least tagged and queryable. What's still missing: it's still one row per ticker — a `both` position still has a single `shares`/`cost_basis` pair, so a long-term core and tactical swing shares on the same ticker aren't separately accounted for yet. Until the schema grows a real per-strategy lot/sleeve (a separate table keyed by ticker + strategy), don't assume `shares` on a `both` position is purely one or the other — track actual swing trade entries/exits some other way (manually, or a lightweight separate table) rather than mutating the shared `positions` row.
