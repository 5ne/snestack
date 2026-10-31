#!/usr/bin/env bash
# Daily PM role: an agentic `claude -p` session (owner's subscription) that reads the
# vision/pm skills, dedups against `snestack feature list`, and writes new `status: proposed`
# feature requests under <brain>/_system/ and <brain>/<domain>/feature-requests/. It replaces
# the "snestack PM feature requests" scheduled task. Writes only proposal files; never edits
# source, never approves anything. Prompt: scripts/prompts/pm-daily.md.
#
# Gated: with no new automation run records since the last successful PM run (and that run under
# 7 days old) no model call is made. After the session, one email lists any new proposals with their
# `feature approve` commands (silence when there are none); a failed run emails the failure.
#
# Usage: pm-daily.sh [--dry-run] [--force]
#   --dry-run  run the session but record the run under a -dryrun directory name; print the email instead of sending.
#   --force    bypass the gate and run the session unconditionally.
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

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$NODE_DIR"
# shellcheck disable=SC1091
. scripts/lib/run-log.sh
# shellcheck disable=SC1091
. scripts/lib/claude-agent.sh

[ -f dist/cli.js ] || { echo "dist/cli.js not found — run 'npm run build' first" >&2; exit 1; }

BRAIN_ROOT="$(node -e 'console.log(require("./dist/core/config").getConfig().getBrainRoot())')"
DAY_DIR="$(date +%Y-%m-%d)"
[ "$DRY_RUN" -eq 1 ] && DAY_DIR="${DAY_DIR}-dryrun"
PUBLISH_DIR="$BRAIN_ROOT/_system/runs/pm/$DAY_DIR"

rl_init pm "$PUBLISH_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)
trap rl_finish EXIT
echo "Run directory: $PUBLISH_DIR (staged in $RUN_DIR; dry run: $DRY_RUN)"

# Gate: exit 4 = nothing new since the last successful PM run, skip without a model call.
gate_rc=0
rl_step pm-gate all node dist/cli.js role-gate --role pm $FORCE_FLAG || gate_rc=$?
if [ "$gate_rc" -eq 4 ]; then
  echo "Gate: nothing new since the last PM run — skipping the session."
  rl_skip pm-session all
  exit 0
fi

NOTIFY_FLAGS=""
[ "$DRY_RUN" -eq 1 ] && NOTIFY_FLAGS="--dry-run"
node dist/cli.js feature list > "$RUN_DIR/proposals-before.txt" 2>/dev/null || true

# PM may read anything, write only files (acceptEdits), and run the read-only snestack CLI + git history.
ALLOWED='Read,Glob,Grep,Edit,Write,Bash(node dist/cli.js feature list*),Bash(node dist/cli.js run-check*),Bash(node dist/cli.js signals*),Bash(git log*),Bash(git diff*),Bash(git show*),Bash(git status*),Bash(ls*),Bash(cat*),Bash(date*)'

rc=0
RL_ERR_FILE="$RUN_DIR/report.md.err" rl_step pm-session all \
  run_claude_agent scripts/prompts/pm-daily.md "$RUN_DIR/report.md" 40 "$ALLOWED" || rc=$?
cat "$RUN_DIR/report.md" 2>/dev/null || true

# Autonomy policy (core/autoMerge.ts): approve low-risk proposals so the 5pm eng run builds them.
[ "$rc" -ne 0 ] || node dist/cli.js feature auto-approve $NOTIFY_FLAGS | tee "$RUN_DIR/auto-approve.txt" || true

# Email: new proposals (or the failure). Never lets a mail problem fail the run.
if [ "$rc" -eq 0 ]; then
  [ "$DRY_RUN" -eq 1 ] || node dist/cli.js role-gate --role pm --record || true
  node dist/cli.js role-notify --role pm --report "$RUN_DIR/report.md" --before "$RUN_DIR/proposals-before.txt" $NOTIFY_FLAGS || true
else
  node dist/cli.js role-notify --role pm --failed --error-file "$RUN_DIR/report.md.err" $NOTIFY_FLAGS || true
fi
echo "Done. Full run saved under: $PUBLISH_DIR"
exit "$rc"
