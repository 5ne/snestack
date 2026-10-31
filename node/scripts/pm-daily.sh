#!/usr/bin/env bash
# Daily PM role: an agentic `claude -p` session (owner's subscription) that reads the
# vision/pm skills, dedups against `snestack feature list`, and writes new `status: proposed`
# feature requests under <brain>/_system/ and <brain>/<domain>/feature-requests/. It replaces
# the "snestack PM feature requests" scheduled task. Writes only proposal files; never edits
# source, never approves anything. Prompt: scripts/prompts/pm-daily.md.
#
# Usage: pm-daily.sh [--dry-run]
#   --dry-run  run the session but record the run under a -dryrun directory name.
set -euo pipefail

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
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

# PM may read anything, write only files (acceptEdits), and run the read-only snestack CLI + git history.
ALLOWED='Read,Glob,Grep,Edit,Write,Bash(node dist/cli.js feature list*),Bash(node dist/cli.js run-check*),Bash(node dist/cli.js signals*),Bash(git log*),Bash(git diff*),Bash(git show*),Bash(git status*),Bash(ls*),Bash(cat*),Bash(date*)'

rc=0
RL_ERR_FILE="$RUN_DIR/report.md.err" rl_step pm-session all \
  run_claude_agent scripts/prompts/pm-daily.md "$RUN_DIR/report.md" 40 "$ALLOWED" || rc=$?
cat "$RUN_DIR/report.md" 2>/dev/null || true
echo "Done. Full run saved under: $PUBLISH_DIR"
exit "$rc"
