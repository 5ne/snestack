#!/usr/bin/env bash
# Intraday swing-trading check: runs the swing-trading-large-cap skill for
# every position/watchlist ticker. Replaces the swing-trading half of the old
# single nightly daily-analysis.sh (now long-term-quality only) — swing calls
# need their own, tighter cadence (several times a day, market hours) rather
# than once overnight. distill-signals/notify only ever see this run's own
# directory, so they're automatically scoped to swing output, nothing else.
#
# Cron'd several times a day, market hours only (see node/README.md). Each
# run gets its own timestamped subdirectory so runs in the same day don't
# collide or overwrite each other's run log.
#
# Usage: swing-check.sh [--dry-run] [--tickers INTU,GOOG]
set -euo pipefail

DRY_RUN=0
ONLY_TICKERS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tickers) ONLY_TICKERS="${2:-}"; shift ;;
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
RUN_DIR="$BRAIN_ROOT/financial/runs/swing-check/$DAY_DIR/$(date +%H%M%S)"

rl_init financial-swing-check "$RUN_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)
trap rl_finish EXIT
echo "Run directory: $RUN_DIR (dry run: $DRY_RUN)"

# Step 1: snapshot the cache (data-dump is a pure read — see Phase 5) to get the ticker list.
RL_ERR_FILE="$RUN_DIR/data-dump.log" rl_step data-dump all \
  node dist/cli.js data-dump > "$RUN_DIR/data-dump.json" 2> "$RUN_DIR/data-dump.log"

TICKERS="$(node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
  const start = lines.findIndex(l => l === "[");
  JSON.parse(lines.slice(start).join("\n")).forEach(d => console.log(d.ticker));
' "$RUN_DIR/data-dump.json")"

if [ -n "$ONLY_TICKERS" ]; then
  TICKERS="$(echo "$ONLY_TICKERS" | tr ',' '\n')"
elif [ "$DRY_RUN" -eq 1 ]; then
  TICKERS="$(echo "$TICKERS" | sed -n '1,2p')"
fi

if [ -z "$TICKERS" ]; then
  echo "No positions/watchlist tickers found — nothing to check." >&2
  exit 0
fi

# Step 2: run the swing-trading skill for every ticker.
while IFS= read -r TICKER; do
  echo "Checking $TICKER..."
  OUT="$RUN_DIR/$TICKER-swing-trading-large-cap.md"
  ERR="$RUN_DIR/$TICKER-swing-trading-large-cap.log"
  rc=0
  RL_ERR_FILE="$ERR" rl_step "run-skill:swing-trading-large-cap" "$TICKER" \
    node dist/cli.js run-skill financial swing-trading-large-cap "$TICKER" > "$OUT.tmp" 2> "$ERR" || rc=$?
  # Keep the write-up if it succeeded or was merely cut off; drop it (and any stale copy) on failure.
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ]; then mv "$OUT.tmp" "$OUT"; else rm -f "$OUT.tmp" "$OUT"; fi
done <<< "$TICKERS"

# Step 3: distill this run's write-ups into one signals array (swing-only, since that's all that's in $RUN_DIR).
if compgen -G "$RUN_DIR/*-swing-trading-large-cap.md" >/dev/null; then
  RL_ERR_FILE="$RUN_DIR/distill.log" rl_step distill all \
    node dist/cli.js distill-signals --dir "$RUN_DIR" > "$RUN_DIR/signals.json" 2> "$RUN_DIR/distill.log" || true
else
  echo "No successful write-ups to distill." >&2
  rl_skip distill
fi

# Step 4: send the batch email and record signals in snestack.db (dry run: preview only).
if [ -s "$RUN_DIR/signals.json" ]; then
  NOTIFY_FLAGS=""
  [ "$DRY_RUN" -eq 1 ] && NOTIFY_FLAGS="--dry-run"
  RL_ERR_FILE="$RUN_DIR/notify.log" rl_step notify all \
    node dist/cli.js notify --file "$RUN_DIR/signals.json" $NOTIFY_FLAGS > "$RUN_DIR/notify.out" 2> "$RUN_DIR/notify.log" || true
  cat "$RUN_DIR/notify.out"
else
  rl_skip notify
fi

echo "Done. Run saved under: $RUN_DIR"
