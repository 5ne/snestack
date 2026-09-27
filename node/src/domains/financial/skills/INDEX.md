---
domain: financial
type: index
---

# snestack Skills Index

Entry point for Claude (or whatever thin harness is running snestack) when analyzing a ticker. Read this first, then the specific skill(s) that apply.

## Available skills

- `long-term-quality.md` — buy-and-hold judgment: is the growth thesis intact, is the business durably profitable, is this a good moment to add. Applies to your current positions and most watchlist names by default.
- `swing-trading-large-cap.md` — tactical RSI-swing trading, restricted to large-cap/highly-profitable names only. Can run alongside `long-term-quality.md` on the same ticker — they're independent judgments, not merged into one call.
- `private-company-eval.md` — placeholder for private/pre-IPO holdings. Nothing exists to apply it to yet.
- `references/quality-bar.md` — shared numeric defaults (profitability bar, RSI thresholds, market-cap cutoff) both trading skills read from. Tune the numbers here rather than duplicating them per-skill.

## Which skill(s) apply to a given ticker

Run `long-term-quality.md` for every current position and watchlist name — that's the default lens for this system. Additionally run `swing-trading-large-cap.md` for any ticker that passes its eligibility filter in `references/quality-bar.md`, whether or not it's also a long-term holding. If both ran, report their conclusions separately — a swing SELL and a long-term HOLD on the same ticker are not a contradiction, they're two different strategies with two different time horizons.

## Running a skill

The current path is `snestack run-skill financial <skill> <TICKER>` — the core harness (`core/runSkill.ts`) loads the skill's frontmatter, resolves whatever it lists under `requires`/`references` (`quote`, `fundamentals`, `brain`, `quality-bar`) via `domains/financial/contextTools.ts`, and runs the assembled prompt through Claude. You don't need to manually run `data-dump` first or hand-assemble context — a skill's frontmatter declares what it needs and the harness fetches it.

- `data-dump` (`snestack data-dump`) still exists as a purely deterministic, no-Claude-call JSON dump of quote/RSI/MA/fundamentals for every position/watchlist ticker — useful for a manual sanity check or for a nightly job that wants to refresh `snestack.db`'s cached RSI/MA before a batch of `run-skill` calls (see `prompts/daily-analysis.md` at the repo root).
- `notify` (`snestack notify --file <path>`) sends a batch email and records signals into `snestack.db`'s `signals` table, given a JSON array of `{ticker, recommendation, confidence, reasoning, fromWatchlist}` — `run-skill`'s own output is prose, not this format, so turning one into the other (across multiple tickers/skills) is a judgment step, not automated yet.

## Status

Scaffolded 2026-08-23 from a conversation working out the actual investment philosophy (see `brain/` for the raw material this was built from). Fully migrated to the skill-harness architecture as of the `move-to-skills-based` branch — the old hardcoded judgment now lives at `domains/financial/agents/cfoAgent.ts` (deprecated, kept for reference via the `analyze`/`batch` CLI commands, prints a deprecation warning) and `domains/financial/orchestrator.ts` (also deprecated). `run-skill` is the intended way to invoke judgment now.
