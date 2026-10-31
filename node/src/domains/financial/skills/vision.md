---
name: vision
domain: financial
type: vision
---

# Vision: Financial Domain

**Purpose of this file:** context for a PM or SWE agent deciding what to
build next *specifically for the financial domain* — triaging or
implementing a proposal under `<brain>/financial/feature-requests/`, or
scoping new work nobody's filed yet. Read the harness-level
`core/skills/vision.md` first — everything there (judgment stays in
markdown, ingestion/judgment separation, gating, cost-consciousness, no
autonomous consequential action) applies here without exception. This file
is only the parts specific to *this* domain.

## Mission

Give the owner a disciplined, written second opinion on their own portfolio
and watchlist — grounded in their own stated thesis per company
(`brain/investing/public/companies/{TICKER}.md`), not a generic stock
screener's opinion. The domain exists to make the owner's own investment
philosophy (long-term quality holding, plus a separate tactical swing lens
on eligible large-caps) consistently and cheaply re-applied as new data
comes in, not to discover or inject a philosophy of its own.

This was the original domain snestack was built for (scaffolded 2026-08-23
from a conversation working out the actual investment philosophy — see
`brain/` for that raw material) and is still the most mature: two live
judgment skills (`long-term-quality.md`, `swing-trading-large-cap.md`), a
shared numeric reference both read from (`references/quality-bar.md`), a
fully separated ingestion pipeline (`data-refresh --tier
intraday|daily|weekly`), and proposals from the PM role (`pm.md`).

## Non-negotiables specific to this domain

1. **This system never places a trade, and never will.** Every skill here
   ends in a written judgment (a `VERDICT:` line for signal-producing
   skills) that a human reads and acts on, or doesn't. No proposal that
   moves toward auto-execution — even "just a confirmation click away" —
   is in scope, ever, regardless of how good verdict quality gets. The
   `README.md`'s own disclaimer ("educational purposes only... not
   responsible for investment losses") is load-bearing, not boilerplate.
2. **Long-term and swing judgments stay independent.** `long-term-quality`
   and `swing-trading-large-cap` are deliberately separate skills with
   separate time horizons, and a long-term HOLD alongside a swing SELL on
   the same ticker is a correct output, not a bug to reconcile. Don't merge
   them into one call or one verdict to simplify the pipeline.
3. **Thresholds live in `references/quality-bar.md`, not in a skill body
   or in code.** They're explicitly marked as drafts the owner reacts to,
   not settled constants — expect them to get tuned, and build anything
   that reads them (a backtest, a new skill) to read that file at run time,
   not a copy.
4. **Two independent fundamentals sources stay independent.** Finnhub and
   Morningstar rows are kept apart in the financial database (`source` column) on
   purpose, because the two providers' figures aren't reconciled against
   each other. A proposal to "merge" or "resolve conflicts between" them
   needs real justification, not just schema tidiness.
5. **`run-skill`/`data-dump` never call a live provider.** Only
   `data-refresh` does, tier by tier. This split is what makes a batch of
   `run-skill` calls cheap and predictable — any new per-ticker skill must
   read from the same cache-first path (`contextTools.ts`), falling back to
   a logged live fetch only as the existing safety net already does.

## Current state

- `long-term-quality.md` — buy-and-hold judgment against the owner's own
  per-company thesis; default lens, runs for every position/watchlist name.
- `swing-trading-large-cap.md` — tactical RSI-based swing judgment,
  restricted to large-cap/highly-profitable names via `quality-bar.md`'s
  eligibility filter.
- `private-company-eval.md` — drafted, nothing to apply it to yet (no
  private/pre-IPO holdings exist today).
- Pipeline-health proposals (missed runs, stale cache, cost anomalies)
  come from the PM role (`scripts/pm-daily.sh`) into
  `<brain>/financial/feature-requests/`.
- Four cron jobs (`data-refresh-intraday.sh`, `data-refresh-daily.sh`,
  `daily-analysis.sh`, `swing-check.sh`) carry this end to end without the
  owner running anything by hand day to day; `run-check` watches their
  health.

## Candidate directions (from `README.md`'s Roadmap — not commitments, and
not ranked; a PM agent should weigh these against actual
`feature-requests/` evidence, not just copy this list)

- A second fundamentals provider behind the existing `FundamentalsProvider`
  interface (a Morningstar API subscription has been mentioned) — purely
  additive if it arrives; must not collapse the Finnhub/Morningstar
  separation above.
- Offline backtesting / threshold tuning for `quality-bar.md`'s numbers,
  reading the same skill/brain markdown a live run would — explicitly
  **never** run live inside the harness itself (this is already called out
  in `CLAUDE.md`'s broader guidance; a PM/SWE agent should treat "offline
  only" as a hard constraint on this one, not a suggestion).
- `private-company-eval.md` graduating from draft to live, once there's an
  actual private holding to apply it to — don't build this speculatively
  ahead of that.
- Longer-term, further out than anything else here: a web UI, a Postgres/
  Supabase migration, and real broker integrations (Schwab, Alpaca). These
  are explicitly the most speculative items in the roadmap and the most
  likely to conflict with principle 1 above if scoped carelessly (a broker
  *integration* for read-only position sync is very different from
  anything that could place an order) — any proposal here needs explicit,
  careful scoping against that line before it's approved, not after.

## Non-goals

- Not a trading bot, now or later (see non-negotiable 1).
- Not a general stock-research tool for tickers outside the owner's own
  positions/watchlist — this domain exists to apply *the owner's* thesis,
  not to generate new ideas from a screener.
- Not optimizing for model sophistication over the owner's own stated
  philosophy. If a verdict and `quality-bar.md`'s intent disagree, that's a
  skill-prompt bug to fix, not evidence the thresholds are wrong.
