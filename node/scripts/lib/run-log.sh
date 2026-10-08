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

rl_init() {
  RL_SCRIPT="$1"
  RL_PUBLISH_DIR="$2"
  RL_DRY_RUN_FLAG=""
  [ "${3:-}" = "--dry-run" ] && RL_DRY_RUN_FLAG="--dry-run"
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
  exit "$rc"
}
