---
domain: financial
type: index
---

# fstack Skills Index

Entry point for Claude (or whatever thin harness is running fstack) when analyzing a ticker. Read this first, then the specific skill(s) that apply.

## Available skills

- `long-term-quality.md` — buy-and-hold judgment: is the growth thesis intact, is the business durably profitable, is this a good moment to add. Applies to your current positions and most watchlist names by default.
- `swing-trading-large-cap.md` — tactical RSI-swing trading, restricted to large-cap/highly-profitable names only. Can run alongside `long-term-quality.md` on the same ticker — they're independent judgments, not merged into one call.
- `private-company-eval.md` — placeholder for private/pre-IPO holdings. Nothing exists to apply it to yet.
- `references/quality-bar.md` — shared numeric defaults (profitability bar, RSI thresholds, market-cap cutoff) both trading skills read from. Tune the numbers here rather than duplicating them per-skill.

## Which skill(s) apply to a given ticker

Run `long-term-quality.md` for every current position and watchlist name — that's the default lens for this system. Additionally run `swing-trading-large-cap.md` for any ticker that passes its eligibility filter in `references/quality-bar.md`, whether or not it's also a long-term holding. If both ran, report their conclusions separately — a swing SELL and a long-term HOLD on the same ticker are not a contradiction, they're two different strategies with two different time horizons.

## Data sources these skills expect

- Quote + RSI/50MA/200MA + Morningstar fundamentals for every position/watchlist ticker: run `node dist/cli.js data-dump` from `node/` (built via `npm run build`, needs `NODE_OPTIONS=--experimental-sqlite`). Purely deterministic — no CFO/Claude call — prints one JSON object per ticker.
- This ticker's own history and your stated thesis: `brain/investing/public/companies/{TICKER}.md`.
- To report a decision back out: write signals as a JSON array of `{ticker, recommendation, confidence, reasoning, fromWatchlist}` and run `node dist/cli.js notify --file <path>` — sends the batch email via your existing Gmail setup and records the signals into `fstack.db`'s `signals` table.

## Status

Scaffolded 2026-08-23 from a conversation working out the actual investment philosophy (see `brain/` for the raw material this was built from). The old hardcoded judgment in `node/src/agents/strategyAgent.ts`, `equityAgent.ts`, and `cfoAgent.ts` is still there but no longer the intended path — `data-dump`/`notify` plus these skill files are what the scheduled Claude-driven analysis (see the "fstack daily investment analysis" scheduled task) actually uses. The old `npm run dev -- batch` command and its cron/scheduler.ts path are now legacy, kept for reference, not deleted yet.
