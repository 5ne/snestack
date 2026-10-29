---
domain: financial
type: index
---

# snestack Skills Index

Entry point for Claude (or whatever thin harness is running snestack) when analyzing a ticker. Read this first, then the specific skill(s) that apply.

## Available skills

- `vision.md` — product/engineering vision for this domain: mission, non-negotiables, current state, candidate directions. Read this (plus `../../../core/skills/vision.md`) before triaging or implementing a `feature-requests/` proposal — it's never run through `run-skill`.
- `long-term-quality.md` — buy-and-hold judgment: is the growth thesis intact, is the business durably profitable, is this a good moment to add. Applies to your current positions and most watchlist names by default.
- `swing-trading-large-cap.md` — tactical RSI-swing trading, restricted to large-cap/highly-profitable names only. Can run alongside `long-term-quality.md` on the same ticker — they're independent judgments, not merged into one call.
- `private-company-eval.md` — placeholder for private/pre-IPO holdings. Nothing exists to apply it to yet.
- `references/quality-bar.md` — shared numeric defaults (profitability bar, RSI thresholds, market-cap cutoff) both trading skills read from. Tune the numbers here rather than duplicating them per-skill.
- `improve-self.md` — domain-level reflection on the pipeline's own automation health (not a ticker judgment): reads recent `run-check` findings/run summaries via the `reflectionDigest` context tool and proposes concrete, evidence-backed improvements as `## Feature Request:` sections, parsed deterministically by `core/featureRequests.ts` into files under `<brain>/financial/feature-requests/`. Never writes source code or a BUY/SELL/HOLD verdict; `build-signals` never reads its output.

## Which skill(s) apply to a given ticker

Run `long-term-quality.md` for every current position and watchlist name — that's the default lens for this system. Additionally run `swing-trading-large-cap.md` for any ticker that passes its eligibility filter in `references/quality-bar.md`, whether or not it's also a long-term holding. If both ran, report their conclusions separately — a swing SELL and a long-term HOLD on the same ticker are not a contradiction, they're two different strategies with two different time horizons.

## Running a skill

The current path is `snestack run-skill financial <skill> <TICKER>` — the core harness (`core/runSkill.ts`) loads the skill's frontmatter, resolves whatever it lists under `requires`/`references` (`quote`, `fundamentals`, `brain`, `quality-bar`) via `domains/financial/contextTools.ts`, and runs the assembled prompt through Claude. `contextTools.ts`'s `quote`/`fundamentals` read only from `snestack.db`'s cache (`data-refresh` is the only thing that populates it — see below) — `run-skill` itself never calls Finnhub/Twelve Data/Morningstar. If the cache is missing or badly stale it still works: it falls through to a live fetch as a safety net, just slower and with a `warn`-level log line, so a skill never silently runs on nothing even if `data-refresh` hasn't run recently.

- `data-refresh --tier <intraday|daily|weekly>` (`snestack data-refresh --tier daily`) is the **only** command that ever calls Finnhub/Twelve Data/Morningstar, scoped by tier: `intraday` refreshes live quote price only (skips fundamentals — cheap, can run every 30 min); `daily` additionally refreshes Finnhub live fundamentals and the once-daily RSI/50MA/200MA closes; `weekly` re-parses whatever Morningstar PDF currently sits in `reports/`. Run it before a batch of `run-skill` calls to make sure they hit cache, not the live-fetch safety net — see `node/scripts/data-refresh-daily.sh`/`data-refresh-intraday.sh` for the cron-scheduled forms.
- `data-dump` (`snestack data-dump`) is a purely deterministic, no-Claude-call, **no-network-call** JSON dump of whatever `data-refresh` last cached (quote/RSI/MA/fundamentals) for every position/watchlist ticker — useful for a manual sanity check. It does not populate the cache itself; run `data-refresh` first if the cache is empty or stale.
- `run-skill --gated` consults a skill's `gate:` frontmatter first (RSI, price-move, age, input-changed triggers — see `core/gate.ts`) and skips the model call (exit 4) when nothing's worth a fresh look; `build-signals` (`snestack build-signals --dir <run dir>`) turns a directory of write-ups into a notify-ready signals array by reading each one's trailing `VERDICT: LABEL | confidence | reasoning` line deterministically, no model call. `run-skill --out <file>` writes the write-up to a file and reads it back to confirm it landed (exit 5 on mismatch) instead of printing to stdout.
- `notify` (`snestack notify --file <path>`) sends a batch email and records signals into `snestack.db`'s `signals` table, given the JSON array `build-signals` produces. `notify-summary` (`snestack notify-summary --dir <run dir>`) emails a deterministic run summary instead — for a quiet day where every call was gated off, or a run that didn't finish cleanly.

## Status

Scaffolded 2026-08-23 from a conversation working out the actual investment philosophy (see `brain/` for the raw material this was built from). Fully migrated to the skill-harness architecture as of the `move-to-skills-based` branch; the old hardcoded-judgment path (`CfoAgent`, `orchestrator.ts`, the `analyze`/`batch`/`retry`/`scheduler` commands) has since been removed. `run-skill` is the way to invoke judgment; ingestion and judgment are now fully separated (see the financial data pipeline migration plan) across four cron jobs: `data-refresh-intraday.sh`, `data-refresh-daily.sh`, `daily-analysis.sh` (long-term-quality only), and `swing-check.sh` (swing-trading-large-cap only).
