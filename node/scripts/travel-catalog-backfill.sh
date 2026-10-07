#!/usr/bin/env bash
# Nightly travel backfill: catalogs ONE year per run, working backwards from
# START_YEAR to END_YEAR, then does nothing once every year is done.
#
# A year counts as "done" if it already has an index, either canonical
# (travel/<year>/00-index-<year>.md) or staged by the automated path
# (travel/<year>/.nightly-draft/00-index-<year>.md). State lives entirely in the
# filesystem, so a failed night (no draft written) is simply retried the next night.
# Output lands in .nightly-draft/ for review — see `snestack travel catalog`.
#
# Usage: travel-catalog-backfill.sh [--dry-run]   (--dry-run prints the chosen year and exits)
set -euo pipefail

START_YEAR=2019   # 2020+ were cataloged by hand
END_YEAR=2010

# cron runs with a minimal PATH, so node (installed via nvm) isn't visible unless we load it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NODE_DIR"

if [ ! -f dist/cli.js ]; then
  echo "dist/cli.js not found — run 'npm run build' first" >&2
  exit 1
fi

BRAIN_ROOT="$(node -e 'console.log(require("./dist/core/config").getConfig().getBrainRoot())')"
TRAVEL_DIR="$BRAIN_ROOT/travel"

YEAR=""
for ((y = START_YEAR; y >= END_YEAR; y--)); do
  if [ ! -f "$TRAVEL_DIR/$y/00-index-$y.md" ] && [ ! -f "$TRAVEL_DIR/$y/.nightly-draft/00-index-$y.md" ]; then
    YEAR="$y"
    break
  fi
done

if [ -z "$YEAR" ]; then
  echo "$(date '+%F %T') Travel backfill complete: every year $END_YEAR-$START_YEAR has an index. Nothing to do (safe to remove this cron entry)."
  exit 0
fi

if [ "${1:-}" = "--dry-run" ]; then
  echo "Next year to catalog: $YEAR"
  exit 0
fi

echo "$(date '+%F %T') Travel backfill: cataloging $YEAR..."
node dist/cli.js travel catalog "$YEAR"
echo "$(date '+%F %T') Done with $YEAR."
