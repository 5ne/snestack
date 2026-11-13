#!/usr/bin/env bash
# Intraday swing-trading check: runs the swing-trading-large-cap skill (gated,
# like daily-analysis.sh's long-term-quality call) for every position/watchlist
# ticker. Replaces the swing-trading half of the old single nightly
# daily-analysis.sh (now long-term-quality only) — swing calls need their own,
# tighter cadence (several times a day, market hours) rather than once
# overnight, and the skill's own `gate:` (RSI <30 or >70 — see
# domains/financial/skills/swing-trading-large-cap.md) means most runs skip
# the model call entirely. build-signals/notify only ever see this run's own
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

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# shellcheck disable=SC1091
. "$NODE_DIR/scripts/lib/run-log.sh"
rl_bootstrap "$NODE_DIR"

DAY_DIR="$(date +%Y-%m-%d)"
[ "$DRY_RUN" -eq 1 ] && DAY_DIR="${DAY_DIR}-dryrun"
PUBLISH_DIR="$BRAIN_ROOT/financial/runs/swing-check/$DAY_DIR/$(date +%H%M%S)"

rl_failure_hook() { rl_default_failure_hook; }

rl_init financial-swing-check "$PUBLISH_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)   # sets $RUN_DIR (local staging)
trap rl_finish EXIT
echo "Run directory: $PUBLISH_DIR (staged in $RUN_DIR; dry run: $DRY_RUN)"

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

# Step 2: run the swing-trading skill for every ticker (gated — most calls skip, no model call).
SKILL=swing-trading-large-cap
while IFS= read -r TICKER; do
  echo "Checking $TICKER..."
  OUT="$RUN_DIR/$TICKER-$SKILL.md"
  ERR="$RUN_DIR/$TICKER-$SKILL.log"
  # run-skill writes and verifies its own output file; exit 5 means the model answered but the file
  # didn't hold it, which is worth one retry.
  for ATTEMPT in 1 2; do
    rc=0
    RL_ERR_FILE="$ERR" rl_step "run-skill:$SKILL" "$TICKER" \
      node dist/cli.js run-skill financial "$SKILL" "$TICKER" --gated --out "$OUT.tmp" 2> "$ERR" || rc=$?
    [ "$rc" -ne 5 ] && break
  done
  # Keep the write-up if it succeeded or was merely cut off; drop it on failure or when the gate skipped the call.
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ]; then mv "$OUT.tmp" "$OUT"; else rm -f "$OUT.tmp" "$OUT"; fi
done <<< "$TICKERS"

# Step 3: build the signals array from each write-up's VERDICT line (deterministic, no model call).
# --only-changed drops a verdict that matches the last one recorded for that ticker+strategy —
# running hourly, an unmoved RSI extreme would otherwise re-email the identical call every time.
BUILD_FLAGS="--only-changed"
[ "$DRY_RUN" -eq 1 ] && BUILD_FLAGS="$BUILD_FLAGS --dry-run"
RL_ERR_FILE="$RUN_DIR/build-signals.log" rl_step build-signals all \
  node dist/cli.js build-signals --dir "$RUN_DIR" $BUILD_FLAGS > "$RUN_DIR/signals.json" 2> "$RUN_DIR/build-signals.log" || true

# Step 4: send the batch email and record signals in the financial database (dry run: preview only).
# Unlike daily-analysis.sh (once a night, so a "no changes" summary is a useful heartbeat),
# this runs several times a day and the gate is specifically there to make most of those
# runs quiet (RSI in the 30-70 band is "no action", every hour, most hours) — emailing a
# summary on every quiet run would mean several "nothing happened" emails a day, defeating
# the point of gating. So: email only when there's something to report; a quiet, successful
# run is recorded in run.json (for run-check) and nothing else. rl_failure_hook above still
# emails if the run actually fails.
SIGNAL_COUNT="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)}catch{console.log(0)}' "$RUN_DIR/signals.json")"
if [ "$SIGNAL_COUNT" -gt 0 ]; then
  NOTIFY_FLAGS=""
  [ "$DRY_RUN" -eq 1 ] && NOTIFY_FLAGS="--dry-run"
  if RL_ERR_FILE="$RUN_DIR/notify.log" rl_step notify all \
    node dist/cli.js notify --file "$RUN_DIR/signals.json" $NOTIFY_FLAGS > "$RUN_DIR/notify.out" 2> "$RUN_DIR/notify.log"; then
    touch "$RUN_DIR/.email-sent"
  fi
  cat "$RUN_DIR/notify.out" 2>/dev/null || true
else
  echo "No new swing recommendations this run — quiet run, no email."
  rl_skip notify
  touch "$RUN_DIR/.email-sent"   # quiet-but-successful isn't a failure; don't let rl_failure_hook fire
fi

echo "Done. Full run saved under: $PUBLISH_DIR"
