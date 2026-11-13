#!/usr/bin/env bash
# Intraday cache refresh: `data-refresh --tier intraday` (live price + the
# once-daily RSI/50MA/200MA cache check) for every position/watchlist ticker.
# Skips Finnhub fundamentals entirely — that's the daily tier's job.
# Cron'd every 30 min, market hours only (see node/README.md for the
# suggested crontab line). Each run gets its own timestamped subdirectory so
# several runs in one day don't collide or overwrite each other's run log.
#
# Usage: data-refresh-intraday.sh [--dry-run] [--tickers INTU,GOOG]
set -euo pipefail

DRY_RUN=0
TICKERS_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tickers) TICKERS_FLAG="--tickers ${2:-}"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# shellcheck disable=SC1091
. "$NODE_DIR/scripts/lib/run-log.sh"
rl_bootstrap "$NODE_DIR"

DAY_DIR="$(date +%Y-%m-%d)"
[ "$DRY_RUN" -eq 1 ] && DAY_DIR="${DAY_DIR}-dryrun"
PUBLISH_DIR="$BRAIN_ROOT/financial/runs/intraday/$DAY_DIR/$(date +%H%M%S)"

rl_init financial-intraday "$PUBLISH_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)   # sets $RUN_DIR (local staging)
trap rl_finish EXIT
echo "Run directory: $PUBLISH_DIR (staged in $RUN_DIR; dry run: $DRY_RUN)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would run: node dist/cli.js data-refresh --tier intraday $TICKERS_FLAG"
  rl_skip data-refresh
else
  RL_ERR_FILE="$RUN_DIR/data-refresh.log" rl_step data-refresh all \
    node dist/cli.js data-refresh --tier intraday $TICKERS_FLAG > "$RUN_DIR/data-refresh.out" 2> "$RUN_DIR/data-refresh.log"
  cat "$RUN_DIR/data-refresh.out"
fi

echo "Done. Full run saved under: $PUBLISH_DIR"
