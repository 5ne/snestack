#!/usr/bin/env bash
# Shared helpers for automation scripts: record each step's outcome in a
# structured run log (see src/core/runLog.ts) so a failed, truncated or missing
# run can be diagnosed afterwards. Source this, then:
#
#   rl_init <script-name> <run-dir> [--dry-run]   # call once, after cd'ing to node/
#   [RL_ERR_FILE=<stderr file>] rl_step <step> <subject> <command...>
#   trap rl_finish EXIT
#
# rl_step runs the command, records ok / failed / truncated (exit code 3) with
# its duration, and returns the command's exit code WITHOUT aborting the script,
# so one bad ticker doesn't stop the rest. rl_finish writes run.json and makes
# the script exit nonzero if any step failed.

rl_init() {
  RL_SCRIPT="$1"
  export SNESTACK_RUN_DIR="$2"
  export SNESTACK_RUN_ID="$(date +%Y%m%dT%H%M%S)-$$"
  RL_DRY_RUN_FLAG=""
  [ "${3:-}" = "--dry-run" ] && RL_DRY_RUN_FLAG="--dry-run"
  mkdir -p "$SNESTACK_RUN_DIR"
  node dist/cli.js run-log event run_start --script "$RL_SCRIPT" $RL_DRY_RUN_FLAG 2>/dev/null || true
}

rl_step() {
  local step="$1" subject="$2"
  shift 2
  local started rc=0 status="ok" ended
  started=$(date +%s)
  "$@" || rc=$?
  ended=$(date +%s)
  if [ "$rc" -eq 3 ]; then
    status="truncated"
  elif [ "$rc" -ne 0 ]; then
    status="failed"
  fi
  local err_args=()
  [ -n "${RL_ERR_FILE:-}" ] && err_args=(--error-file "$RL_ERR_FILE")
  node dist/cli.js run-log event step --step "$step" --subject "$subject" --status "$status" \
    --exit-code "$rc" --duration-ms $(((ended - started) * 1000)) ${err_args[@]+"${err_args[@]}"} 2>/dev/null || true
  return "$rc"
}

# Record a step that was deliberately not run.
rl_skip() {
  node dist/cli.js run-log event step --step "$1" --subject "${2:-all}" --status skipped --exit-code 0 2>/dev/null || true
}

rl_finish() {
  local rc=$?
  trap - EXIT
  node dist/cli.js run-log finalize --exit-code "$rc" || rc=$?
  exit "$rc"
}
