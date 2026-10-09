#!/usr/bin/env bash
# Intraday cache refresh: `data-refresh --tier intraday` (live price + the
# once-daily RSI/50MA/200MA cache check) for every position/watchlist ticker.
# Skips Finnhub fundamentals entirely — that's the daily tier's job.
# Cron'd every 30-60 min, market hours only (see node/README.md for the
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

BRAIN_ROOT="$(node -e 'console.log(require("./dist/core/config").getConfig().getBrainRoot())')"
DAY_DIR="$(date +%Y-%m-%d)"
[ "$DRY_RUN" -eq 1 ] && DAY_DIR="${DAY_DIR}-dryrun"
RUN_DIR="$BRAIN_ROOT/financial/runs/intraday/$DAY_DIR/$(date +%H%M%S)"

rl_init financial-intraday "$RUN_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)
trap rl_finish EXIT
echo "Run directory: $RUN_DIR (dry run: $DRY_RUN)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would run: node dist/cli.js data-refresh --tier intraday $TICKERS_FLAG"
  rl_skip data-refresh
else
  RL_ERR_FILE="$RUN_DIR/data-refresh.log" rl_step data-refresh all \
    node dist/cli.js data-refresh --tier intraday $TICKERS_FLAG > "$RUN_DIR/data-refresh.out" 2> "$RUN_DIR/data-refresh.log"
  cat "$RUN_DIR/data-refresh.out"
fi

echo "Done. Run saved under: $RUN_DIR"
