#!/usr/bin/env bash
# Daily reflection: `snestack reflect` runs every registered domain's
# `improve-self` skill (gated — most days this is a no-op, no model call),
# parses any new proposals it writes, and `reflect-notify` sends one combined
# email if anything new landed (silence on a quiet day). This is a
# harness-level job, not a financial one — it spans every domain in
# config/domains.json, not just financial, which is why its run record is
# staged under <brain>/_system/ rather than <brain>/financial/ like the other
# three cron jobs (see node/README.md's cron table).
#
# This system never edits its own source code, skills, or config — see
# src/core/featureRequests.ts's header comment for the safety line. It only
# ever writes new files under <brain>/<domain>/feature-requests/.
#
# Usage: reflect-check.sh [--dry-run] [--force]
#   --dry-run  run reflect for real (gate + skill + parsing), but don't send
#              the summary email even if something new was written.
#   --force    bypass every domain's gate and run improve-self unconditionally
#              (e.g. to re-check right after a gated-off run, or while testing
#              a skill prompt change) instead of waiting for it to trigger.
set -euo pipefail

DRY_RUN=0
FORCE_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE_FLAG="--force" ;;
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
PUBLISH_DIR="$BRAIN_ROOT/_system/runs/reflect/$DAY_DIR"

rl_init reflect "$PUBLISH_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)   # sets $RUN_DIR (local staging)
trap rl_finish EXIT
echo "Run directory: $PUBLISH_DIR (staged in $RUN_DIR; dry run: $DRY_RUN)"

# Step 1: reflect on every registered domain (gated per-domain inside the command itself —
# a quiet day/week for a given domain costs no model call at all, just the digest assembly).
rc=0
RL_ERR_FILE="$RUN_DIR/reflect.log" rl_step reflect all \
  node dist/cli.js reflect --json $FORCE_FLAG > "$RUN_DIR/reflect.json" 2> "$RUN_DIR/reflect.log" || rc=$?
if [ "$rc" -ne 0 ] || [ ! -s "$RUN_DIR/reflect.json" ]; then
  echo "reflect produced no output (exit $rc) — nothing to notify on." >&2
  exit "$rc"
fi
cat "$RUN_DIR/reflect.log" >&2 || true

# Step 2: send one combined email if (and only if) something new landed — reflect-notify
# itself is a no-op (exit 0, nothing sent) on an all-quiet result.
if [ "$DRY_RUN" -eq 1 ]; then
  node dist/cli.js reflect-notify --file "$RUN_DIR/reflect.json" --dry-run
  rl_skip reflect-notify
else
  RL_ERR_FILE="$RUN_DIR/reflect-notify.log" rl_step reflect-notify all \
    node dist/cli.js reflect-notify --file "$RUN_DIR/reflect.json" > "$RUN_DIR/reflect-notify.out" 2> "$RUN_DIR/reflect-notify.log"
  cat "$RUN_DIR/reflect-notify.out" 2>/dev/null || true
fi

echo "Done. Full run saved under: $PUBLISH_DIR"
