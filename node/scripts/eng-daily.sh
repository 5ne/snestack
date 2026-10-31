#!/usr/bin/env bash
# Daily eng role: an agentic `claude -p` session (owner's subscription) that picks up
# feature requests whose status is `approved`, implements them on an `eng/<slug>` branch
# with tests, and records progress in the proposal file. It replaces the "snestack eng
# approved tasks" scheduled task. It may commit on the eng/ branch but can never push,
# merge, or delete (denied in lib/claude-agent.sh); marking `done` stays a human step.
# Prompt: scripts/prompts/eng-daily.md. If nothing is approved, no model call is made.
#
# Usage: eng-daily.sh [--dry-run]
#   --dry-run  only list what would be picked up (no model call, no changes).
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
PUBLISH_DIR="$BRAIN_ROOT/_system/runs/eng/$DAY_DIR"

rl_init eng "$PUBLISH_DIR" $([ "$DRY_RUN" -eq 1 ] && echo --dry-run)
trap rl_finish EXIT
echo "Run directory: $PUBLISH_DIR (staged in $RUN_DIR; dry run: $DRY_RUN)"

# Deterministic pre-check: no approved items means no model call at all.
APPROVED="$(node dist/cli.js feature list --status approved 2>/dev/null || true)"
echo "$APPROVED" > "$RUN_DIR/approved.txt"
if [ -z "$APPROVED" ] || echo "$APPROVED" | grep -q "^No feature-request proposals found"; then
  echo "No approved feature requests — nothing to do."
  rl_skip eng-session all
  exit 0
fi
echo "Approved:"; echo "$APPROVED"
if [ "$DRY_RUN" -eq 1 ]; then rl_skip eng-session all; exit 0; fi

ALLOWED='Read,Glob,Grep,Edit,Write,Bash(node dist/cli.js feature *),Bash(npm run *),Bash(npx jest*),Bash(npx tsc*),Bash(npx ts-node*),Bash(node *),Bash(git status*),Bash(git diff*),Bash(git log*),Bash(git show*),Bash(git branch*),Bash(git checkout*),Bash(git switch*),Bash(git add*),Bash(git commit*),Bash(ls*),Bash(cat*),Bash(mkdir*),Bash(date*)'

rc=0
RL_ERR_FILE="$RUN_DIR/report.md.err" rl_step eng-session all \
  run_claude_agent scripts/prompts/eng-daily.md "$RUN_DIR/report.md" 120 "$ALLOWED" || rc=$?
cat "$RUN_DIR/report.md" 2>/dev/null || true
echo "Done. Full run saved under: $PUBLISH_DIR"
exit "$rc"
