#!/usr/bin/env bash
# Daily eng role: an agentic `claude -p` session (owner's subscription) that picks up
# feature requests whose status is `approved`, implements them on an `eng/<slug>` branch
# with tests, and records progress in the proposal file. It replaces the "snestack eng
# approved tasks" scheduled task. It may commit on the eng/ branch but can never push,
# merge, or delete (denied in lib/claude-agent.sh); marking `done` stays a human step.
# Prompt: scripts/prompts/eng-daily.md. If nothing is approved, no model call is made.
# Auto-merge (owner-approved autonomy policy, core/autoMerge.ts): for proposals marked auto_approved the script,
# not the agent, merges eng/<id> into main iff every changed path is allowlisted (tests/docs/run-check), the diff has no
# credentials, and typecheck + the full test suite pass on the branch; then it rebuilds dist and marks the request done.
# Anything else is left for the owner. SNESTACK_AUTO_PUSH=1 additionally pushes main (default: local merge only).
# After the session one email carries the eng report (picked up / done / blockers); a failed run emails the failure.
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

REPO_DIR="$(cd "$NODE_DIR/.." && pwd)"
git_r() { git -C "$REPO_DIR" "$@"; }

# Merge eng/<id> branches of auto-approved proposals that pass every check. Writes a human-readable log to $RUN_DIR/merge.txt.
auto_merge_ready() {
  : > "$RUN_DIR/merge.txt"
  local rows id domain branch
  rows="$(node dist/cli.js feature list --status in-progress 2>/dev/null | grep '(auto-approved)' | awk '{print $1, $3}' || true)"
  [ -n "$rows" ] || { echo "No auto-approved work in progress." >> "$RUN_DIR/merge.txt"; return 0; }
  if [ -n "$(git_r status --porcelain)" ]; then
    echo "Working tree is not clean; skipped auto-merge (nothing was merged)." >> "$RUN_DIR/merge.txt"
    return 0
  fi
  while read -r id domain; do
    [ -n "$id" ] || continue
    branch="eng/$id"
    if ! git_r rev-parse --verify -q "$branch" >/dev/null; then
      echo "- $id: no branch $branch found; left for the owner." >> "$RUN_DIR/merge.txt"; continue
    fi
    git_r diff --name-only "main...$branch" > "$RUN_DIR/paths-$id.txt"
    git_r diff "main...$branch" > "$RUN_DIR/diff-$id.txt"
    if ! node dist/cli.js feature merge-check --paths "$RUN_DIR/paths-$id.txt" --diff "$RUN_DIR/diff-$id.txt" > "$RUN_DIR/check-$id.txt" 2>&1; then
      { echo "- $id: NOT auto-merged (needs owner review of $branch):"; sed 's/^/    /' "$RUN_DIR/check-$id.txt"; } >> "$RUN_DIR/merge.txt"; continue
    fi
    git_r checkout -q "$branch"
    if ! (npm run typecheck && npx jest) > "$RUN_DIR/tests-$id.log" 2>&1; then
      git_r checkout -q main
      echo "- $id: NOT auto-merged: typecheck/tests failed on $branch (log: tests-$id.log); left for the owner." >> "$RUN_DIR/merge.txt"; continue
    fi
    git_r checkout -q main
    if ! git_r merge --no-ff -q "$branch" -m "Merge branch '$branch' (auto-merged: low-risk policy, tests green)"; then
      git_r merge --abort 2>/dev/null || true
      echo "- $id: NOT auto-merged: merge conflict; left for the owner." >> "$RUN_DIR/merge.txt"; continue
    fi
    npm run build >/dev/null 2>&1 || echo "  (warning: npm run build failed after merging $id)" >> "$RUN_DIR/merge.txt"
    node dist/cli.js feature done "$id" --domain "$domain" >/dev/null 2>&1 || true
    echo "- $id: MERGED into main (tests green, paths allowlisted); marked done." >> "$RUN_DIR/merge.txt"
    if [ "${SNESTACK_AUTO_PUSH:-0}" = "1" ]; then
      if git_r push -q origin main 2>>"$RUN_DIR/merge.txt"; then echo "  pushed main." >> "$RUN_DIR/merge.txt"; else echo "  push FAILED; main is merged locally." >> "$RUN_DIR/merge.txt"; fi
    fi
  done <<< "$rows"
  git_r checkout -q main 2>/dev/null || true
}

# Start every session from a clean main so the agent's branches fork from it.
if [ -z "$(git_r status --porcelain)" ]; then git_r checkout -q main 2>/dev/null || true; fi

rc=0
RL_ERR_FILE="$RUN_DIR/report.md.err" rl_step eng-session all \
  run_claude_agent scripts/prompts/eng-daily.md "$RUN_DIR/report.md" 120 "$ALLOWED" || rc=$?
cat "$RUN_DIR/report.md" 2>/dev/null || true

# Leave the shared working tree on main: tomorrow's cron jobs run the scripts in this checkout, so they
# must never find it parked on an eng/ branch. Uncommitted leftovers are never discarded; they are reported.
if [ -z "$(git_r status --porcelain)" ]; then
  git_r checkout -q main 2>/dev/null || true
else
  printf '\n**Warning:** the eng session left uncommitted changes on branch `%s`; the working tree was NOT switched back to main. Commit or discard them before the next cron run.\n' "$(git_r branch --show-current)" >> "$RUN_DIR/report.md"
fi

if [ "$rc" -eq 0 ]; then
  rl_step eng-merge all auto_merge_ready || true
  cat "$RUN_DIR/merge.txt" 2>/dev/null || true
  node dist/cli.js role-notify --role eng --report "$RUN_DIR/report.md" --merge-file "$RUN_DIR/merge.txt" --html-out "$RUN_DIR/email.html" || true
else
  node dist/cli.js role-notify --role eng --failed --error-file "$RUN_DIR/report.md.err" || true
fi
echo "Done. Full run saved under: $PUBLISH_DIR"
exit "$rc"
