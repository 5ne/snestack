#!/usr/bin/env bash
# Nightly financial analysis: data-dump -> run-skill (both skills, every ticker)
# -> distill-signals -> notify. This is the automated version of
# prompts/daily-analysis.md, using `distill-signals` in place of a human/Claude-Code
# session doing step 3 by hand. Every command here is a plain deterministic CLI
# call (each with its own single Claude API call where noted) — no agentic
# tool-use loop, so no elevated/unattended permissions are needed to run this
# unattended from cron.
#
# Each step's outcome, and every model call's tokens/latency/stop reason, is recorded
# in <run dir>/run.jsonl and summarized in run.json (see src/core/runLog.ts). Model
# output goes to <TICKER>-<skill>.md and that call's logs to <TICKER>-<skill>.log.
# A ticker that fails is skipped (no .md), the rest still run, and the script exits
# nonzero at the end so the failure is visible.
#
# Usage: daily-analysis.sh [--dry-run] [--tickers INTU,GOOG]
#   --dry-run  run everything but email nothing and record no signals; output goes to
#              <date>-dryrun/. Defaults to the first two tickers unless --tickers is given.
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
RUN_DIR="$BRAIN_ROOT/financial/signals/$(date +%Y-%m-%d)"
if [ "$DRY_RUN" -eq 1 ]; then
  RUN_DIR="${RUN_DIR}-dryrun"
  rm -rf "$RUN_DIR"
fi

rl_init financial-daily "$RUN_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)
trap rl_finish EXIT
echo "Run directory: $RUN_DIR (dry run: $DRY_RUN)"

# Step 1: refresh quote/RSI/MA + fundamentals for every position/watchlist ticker.
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
  echo "No positions/watchlist tickers found — nothing to analyze." >&2
  exit 0
fi

# Step 2: run both skills for every ticker. Each call is its own Claude judgment.
while IFS= read -r TICKER; do
  echo "Analyzing $TICKER..."
  for SKILL in long-term-quality swing-trading-large-cap; do
    OUT="$RUN_DIR/$TICKER-$SKILL.md"
    ERR="$RUN_DIR/$TICKER-$SKILL.log"
    rc=0
    RL_ERR_FILE="$ERR" rl_step "run-skill:$SKILL" "$TICKER" \
      node dist/cli.js run-skill financial "$SKILL" "$TICKER" > "$OUT.tmp" 2> "$ERR" || rc=$?
    # Keep the write-up if it succeeded or was merely cut off; drop it (and any stale copy) on failure.
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ]; then mv "$OUT.tmp" "$OUT"; else rm -f "$OUT.tmp" "$OUT"; fi
  done
done <<< "$TICKERS"

# Step 3: distill all of the successful write-ups into one signals array.
if compgen -G "$RUN_DIR/*-long-term-quality.md" >/dev/null || compgen -G "$RUN_DIR/*-swing-trading-large-cap.md" >/dev/null; then
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

echo "Done. Full run saved under: $RUN_DIR"
