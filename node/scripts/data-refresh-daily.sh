#!/usr/bin/env bash
# Nightly cache refresh: `data-refresh --tier daily` (quote + RSI/MA + Finnhub
# live fundamentals) for every position/watchlist ticker, then `--tier weekly`
# (re-parse whatever Morningstar PDF currently sits in reports/) — gated to
# Mondays only, since the weekly tier re-parses the same on-disk PDF every
# time it runs; there's no point doing that nightly (see Phase 3 of the
# financial pipeline migration plan). Cron'd nightly, before daily-analysis.sh.
#
# Usage: data-refresh-daily.sh [--dry-run] [--tickers INTU,GOOG]
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
PUBLISH_DIR="$BRAIN_ROOT/financial/runs/data-refresh-daily/$(date +%Y-%m-%d)"
[ "$DRY_RUN" -eq 1 ] && PUBLISH_DIR="${PUBLISH_DIR}-dryrun"

rl_init financial-daily-refresh "$PUBLISH_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)   # sets $RUN_DIR (local staging)
trap rl_finish EXIT
echo "Run directory: $PUBLISH_DIR (staged in $RUN_DIR; dry run: $DRY_RUN)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would run: node dist/cli.js data-refresh --tier daily $TICKERS_FLAG"
  rl_skip data-refresh-daily
else
  RL_ERR_FILE="$RUN_DIR/data-refresh-daily.log" rl_step data-refresh-daily all \
    node dist/cli.js data-refresh --tier daily $TICKERS_FLAG > "$RUN_DIR/data-refresh-daily.out" 2> "$RUN_DIR/data-refresh-daily.log"
  cat "$RUN_DIR/data-refresh-daily.out"
fi

WEEKDAY="$(date +%u)" # 1 = Monday
if [ "$WEEKDAY" = "1" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] would run: node dist/cli.js data-refresh --tier weekly $TICKERS_FLAG"
    rl_skip data-refresh-weekly
  else
    RL_ERR_FILE="$RUN_DIR/data-refresh-weekly.log" rl_step data-refresh-weekly all \
      node dist/cli.js data-refresh --tier weekly $TICKERS_FLAG > "$RUN_DIR/data-refresh-weekly.out" 2> "$RUN_DIR/data-refresh-weekly.log"
    cat "$RUN_DIR/data-refresh-weekly.out"
  fi
else
  echo "Not Monday — skipping weekly (Morningstar) tier."
  rl_skip data-refresh-weekly
fi

echo "Done. Full run saved under: $PUBLISH_DIR"
