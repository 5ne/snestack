#!/usr/bin/env bash
# Shared helpers for automation scripts: record each step's outcome in a
# structured run log (see src/core/runLog.ts) so a failed, truncated, skipped or
# missing run can be diagnosed afterwards. Source this, then:
#
#   rl_init <script-name> <publish-dir> [--dry-run]   # once, after cd'ing to node/; sets $RUN_DIR
#   [RL_ERR_FILE=<stderr file>] rl_step <step> <subject> <command...>
#   trap rl_finish EXIT
#
# The run works in a LOCAL staging directory ($RUN_DIR, under ~/Library/Logs/snestack/runs/) and
# rl_finish copies it to <publish-dir> (normally in Google Drive) at the end. Writing
# many files straight onto a cloud-synced folder mid-run proved unreliable (a
# redirect target ended up empty), and the local copy survives a failed publish.
#
# rl_step runs the command, records ok / failed / truncated (exit 3) / skipped (exit 4,
# a gate decided the call wasn't needed) with its duration, and returns the command's
# exit code WITHOUT aborting the script, so one bad ticker doesn't stop the rest.
# rl_finish writes run.json, calls rl_failure_hook (if the script defines one) when the run failed,
# publishes the folder, and exits nonzero if any step failed.

RL_LOCK_OWNED=0
RL_LOCK_DIR=""

# Bootstrap a cron/scheduled script: load nvm + Homebrew/local PATH, cd into
# node/, verify dist/cli.js is built, and resolve BRAIN_ROOT.
rl_bootstrap() {
  local node_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null
  fi
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
  cd "$node_dir"
  if [ ! -f dist/cli.js ]; then
    echo "dist/cli.js not found — run 'npm run build' first" >&2
    exit 1
  fi
  BRAIN_ROOT="$(node -e 'console.log(require("./dist/core/config").getConfig().getBrainRoot())')"
}

# Standard failure hook: email a run summary if the run failed before any
# signal email went out (skipped in --dry-run).
rl_default_failure_hook() {
  [ "${DRY_RUN:-0}" -eq 1 ] && return 0
  [ -e "$RUN_DIR/.email-sent" ] && return 0
  node dist/cli.js notify-summary --dir "$RUN_DIR" > "$RUN_DIR/failure-email.out" 2> "$RUN_DIR/failure-email.log" || true
}

rl_release_lock() {
  if [ "${RL_LOCK_OWNED:-0}" -eq 1 ] && [ -n "${RL_LOCK_DIR:-}" ]; then
    rm -rf "$RL_LOCK_DIR" 2>/dev/null || true
    RL_LOCK_OWNED=0
  fi
}

# Acquire a per-script directory lock so overlapping cron/launchd runs exit
# cleanly instead of piling up on the database. Removes stale locks whose PID
# is no longer alive.
rl_acquire_lock() {
  local locks_root="${SNESTACK_STAGING_ROOT:-$HOME/Library/Logs/snestack}/locks"
  RL_LOCK_DIR="$locks_root/$RL_SCRIPT.lock"
  mkdir -p "$locks_root"

  if ! mkdir "$RL_LOCK_DIR" 2>/dev/null; then
    # Give a concurrent winner a brief moment to write its pid file.
    local i=0
    while [ ! -f "$RL_LOCK_DIR/pid" ] && [ "$i" -lt 5 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    local lock_pid=""
    [ -f "$RL_LOCK_DIR/pid" ] && lock_pid="$(cat "$RL_LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$lock_pid" ] && [[ "$lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$lock_pid" 2>/dev/null; then
      echo "Skipped: $RL_SCRIPT is already running (pid $lock_pid)" >&2
      return 1
    fi
    # Stale lock (dead PID or missing pid file): remove and try once more.
    rm -rf "$RL_LOCK_DIR" 2>/dev/null || true
    if ! mkdir "$RL_LOCK_DIR" 2>/dev/null; then
      lock_pid="$(cat "$RL_LOCK_DIR/pid" 2>/dev/null || true)"
      echo "Skipped: $RL_SCRIPT is already running (pid ${lock_pid:-unknown})" >&2
      return 1
    fi
  fi

  echo "$$" > "$RL_LOCK_DIR/pid"
  RL_LOCK_OWNED=1
  return 0
}

rl_init() {
  RL_SCRIPT="$1"
  RL_PUBLISH_DIR="$2"
  RL_DRY_RUN_FLAG=""
  [ "${3:-}" = "--dry-run" ] && RL_DRY_RUN_FLAG="--dry-run"
  if ! rl_acquire_lock; then
    exit 0
  fi
  trap rl_release_lock EXIT
  # Staged outside ~/Documents and the Drive folder: run outputs have come back empty from synced locations.
  RUN_DIR="${SNESTACK_STAGING_ROOT:-$HOME/Library/Logs/snestack}/runs/$RL_SCRIPT/$(basename "$RL_PUBLISH_DIR")"
  rm -rf "$RUN_DIR"
  mkdir -p "$RUN_DIR"
  export SNESTACK_RUN_DIR="$RUN_DIR"
  export SNESTACK_RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
  node dist/cli.js run-log event run_start --script "$RL_SCRIPT" $RL_DRY_RUN_FLAG 2>/dev/null || true
}

rl_step() {
  local step="$1" subject="$2"
  shift 2
  local started rc=0 status="ok" ended
  started=$(date +%s)
  "$@" || rc=$?
  ended=$(date +%s)
  case "$rc" in
    0) status="ok" ;;
    3) status="truncated" ;;
    4) status="skipped" ;;
    *) status="failed" ;;
  esac
  local err_args=()
  [ -n "${RL_ERR_FILE:-}" ] && err_args=(--error-file "$RL_ERR_FILE")
  node dist/cli.js run-log event step --step "$step" --subject "$subject" --status "$status" \
    --exit-code "$rc" --duration-ms $(((ended - started) * 1000)) ${err_args[@]+"${err_args[@]}"} 2>/dev/null || true
  return "$rc"
}

# Record a step as failed by hand (e.g. a step that exited 0 but left an empty output file).
rl_fail() {
  node dist/cli.js run-log event step --step "$1" --subject "${2:-all}" --status failed --exit-code 1 2>/dev/null || true
}

# Record a step that was deliberately not run.
rl_skip() {
  node dist/cli.js run-log event step --step "$1" --subject "${2:-all}" --status skipped --exit-code 0 2>/dev/null || true
}

rl_finish() {
  local rc=$?
  trap - EXIT
  node dist/cli.js run-log finalize --exit-code "$rc" || rc=$?
  # Let the script react to a failed run (e.g. send a "run had problems" email) now that run.json exists.
  if [ "$rc" -ne 0 ] && declare -F rl_failure_hook >/dev/null; then rl_failure_hook || true; fi
  # Publish the staged run (replacing any earlier same-day run in the destination).
  if mkdir -p "$RL_PUBLISH_DIR" 2>/dev/null &&
    { rsync -a --delete "$RUN_DIR"/ "$RL_PUBLISH_DIR"/ 2>/dev/null || cp -Rp "$RUN_DIR"/. "$RL_PUBLISH_DIR"/; }; then
    echo "Run record published to: $RL_PUBLISH_DIR" >&2
  else
    echo "WARNING: could not publish the run record to $RL_PUBLISH_DIR; it is still at $RUN_DIR" >&2
  fi
  rl_release_lock
  exit "$rc"
}
