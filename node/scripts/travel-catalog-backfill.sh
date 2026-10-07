#!/usr/bin/env bash
# DEPRECATED (2026-10-07) — not scheduled. Each night is one large Anthropic API call
# (plus a 48,000-token output budget), which costs more than it's worth to run on
# the API. The cron entry was removed; this script and `snestack travel catalog` still
# work if run by hand. To catalog a year without API cost, use `snestack travel
# prep-catalog <year>` and paste the prompt into a Claude session that has Gmail access
# (covered by the Claude subscription). To resume the nightly job: re-add the cron line
#   0 2 * * * cd <repo>/node && ./scripts/travel-catalog-backfill.sh >> logs/travel-backfill.cron.log 2>&1
# and restore the "travel-backfill" expectation in the run-check command (src/cli.ts).
#
# Nightly travel backfill: catalogs ONE year per run, working backwards from 2019 to
# 2010 (see src/domains/travel/tools/backfill.ts), then does nothing once every year
# is done. A night that fails writes no index, so that year is retried the next night.
# Output lands in travel/<year>/.nightly-draft/ for review — see `snestack travel catalog`.
#
# Each run is recorded in travel/_runs/<date>/ (run.jsonl + run.json; model call
# tokens, latency, stop reason; step outcome) and its logs in catalog.log there.
#
# Usage: travel-catalog-backfill.sh [--plan | --dry-run]
#   --plan     print the year it would catalog and exit (no model call)
#   --dry-run  do the full run for that year, but write the files into the run's own
#              folder instead of the year's draft, so it changes nothing in the catalog
#              and doesn't advance the backfill
set -euo pipefail

MODE="run"
case "${1:-}" in
  "") ;;
  --plan) MODE="plan" ;;
  --dry-run) MODE="dry-run" ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac

# cron runs with a minimal PATH, so node (installed via nvm) isn't visible unless we load it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NODE_DIR"
# shellcheck disable=SC1091
. scripts/lib/run-log.sh

if [ ! -f dist/cli.js ]; then
  echo "dist/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi

YEAR="$(node dist/cli.js travel next-year)"

if [ -z "$YEAR" ]; then
  echo "$(date '+%F %T') Travel backfill complete: every year is cataloged. Nothing to do (safe to remove this cron entry)."
  exit 0
fi

if [ "$MODE" = "plan" ]; then
  echo "Next year to catalog: $YEAR"
  exit 0
fi

BRAIN_ROOT="$(node -e 'console.log(require("./dist/core/config").getConfig().getBrainRoot())')"
RUN_DIR="$BRAIN_ROOT/travel/_runs/$(date +%Y-%m-%d)"
CATALOG_ARGS=("$YEAR")
if [ "$MODE" = "dry-run" ]; then
  RUN_DIR="${RUN_DIR}-dryrun"
  rm -rf "$RUN_DIR"
  CATALOG_ARGS+=(--out-dir "$RUN_DIR/draft")
fi

rl_init travel-backfill "$RUN_DIR" $([ "$MODE" = "dry-run" ] && echo --dry-run)
trap rl_finish EXIT

echo "$(date '+%F %T') Travel backfill: cataloging $YEAR (mode: $MODE, run dir: $RUN_DIR)..."
RL_ERR_FILE="$RUN_DIR/catalog.log" rl_step travel-catalog "$YEAR" \
  node dist/cli.js travel catalog "${CATALOG_ARGS[@]}" > "$RUN_DIR/catalog.out" 2> "$RUN_DIR/catalog.log" || rc=$?
cat "$RUN_DIR/catalog.out"
echo "$(date '+%F %T') Finished $YEAR (exit ${rc:-0})."
