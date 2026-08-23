# fstack Brain

One markdown file per company under `companies/`, in the gBrain-style "compiled truth + timeline" pattern: your own stated thesis at the top (quoted verbatim from `fstack.db`), then a dated history underneath.

## Companies

| Ticker | Status | Thesis on file? |
|---|---|---|
| AAPL | position | yes |
| AMZN | position | yes |
| GOOG | position | no |
| INTU | position | no |
| META | position | yes |
| MSFT | position | no |
| MU | watchlist | yes |
| NFLX | position | no |
| NVDA | position | yes |
| RIVN | watchlist | yes |
| DELL | watchlist | yes |

No private-company entries exist yet — see `skills/private-company-eval.md`.

## Where this came from

Migrated 2026-08-23 from `fstack.db`'s `positions.notes`, `watchlist.thesis`, and `signals.reasoning` columns (the ones flagged in the architecture discussion as narrative content that shouldn't live in db TEXT columns). The db still has this data too — nothing was deleted there, this is a copy in a more useful shape. Once `skills/` is actually wired into the live pipeline, new entries should append here as dated timeline additions rather than being re-derived from the db.

## Updating

Add a new dated bullet under a ticker's `## History` section when a fresh judgment call is made — don't overwrite the compiled thesis at the top unless the underlying thesis has genuinely changed (and if so, keep the old one in history rather than deleting it).
