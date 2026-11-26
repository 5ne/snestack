#!/usr/bin/env bash
set -euo pipefail

# Manage the 4 snestack financial scheduled jobs as macOS user LaunchAgents
# (`~/Library/LaunchAgents/com.snestack.financial.*.plist`) so they run inside
# the user's GUI session with macOS Keychain access (required for `agy` OAuth).
#
# Usage:
#   ./scripts/schedule-macos.sh install
#   ./scripts/schedule-macos.sh status
#   ./scripts/schedule-macos.sh uninstall
#   ./scripts/schedule-macos.sh print-plists

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Keep logs and WorkingDirectory outside TCC-protected folders (like ~/Documents)
# because launchd's pre-exec xpcproxy opens StandardOutPath and chdirs before exec'ing /bin/bash.
LOG_DIR="${SNESTACK_SCHEDULE_LOG_DIR:-$HOME/Library/Logs/snestack}"
PLIST_DIR="${SNESTACK_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PREFIX="${SNESTACK_SCHEDULE_PREFIX:-com.snestack.financial}"

JOBS=(
  "data-refresh-intraday"
  "data-refresh-daily"
  "daily-analysis"
  "swing-check"
)

CMD="${1:-help}"

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}

resolve_service_path() {
  local node_bin
  if [ -n "${SNESTACK_NODE_BIN:-}" ]; then
    node_bin="$SNESTACK_NODE_BIN"
  else
    node_bin="$(command -v node)"
  fi
  local node_bin_dir
  node_bin_dir="$(dirname "$node_bin")"
  printf '%s' "${node_bin_dir}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

emit_calendar_dict() {
  local weekday="$1" hour="$2" minute="$3"
  cat <<EOF
    <dict>
      <key>Weekday</key>
      <integer>${weekday}</integer>
      <key>Hour</key>
      <integer>${hour}</integer>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>
EOF
}

emit_schedule_intervals() {
  local job="$1"
  echo "  <key>StartCalendarInterval</key>"
  echo "  <array>"
  case "$job" in
    data-refresh-intraday)
      for wd in 1 2 3 4 5; do
        for hr in 6 7 8 9 10 11 12 13; do
          emit_calendar_dict "$wd" "$hr" 0
          emit_calendar_dict "$wd" "$hr" 30
        done
      done
      ;;
    data-refresh-daily)
      for wd in 1 2 3 4 5; do
        emit_calendar_dict "$wd" 14 0
      done
      ;;
    daily-analysis)
      for wd in 1 2 3 4 5; do
        emit_calendar_dict "$wd" 14 30
      done
      ;;
    swing-check)
      for wd in 1 2 3 4 5; do
        for hr in 7 8 9 10 11 12 13; do
          emit_calendar_dict "$wd" "$hr" 0
        done
      done
      ;;
    *)
      echo "Unknown job: $job" >&2
      exit 1
      ;;
  esac
  echo "  </array>"
}

generate_plist() {
  local job="$1"
  local label="${PREFIX}.${job}"
  local script_abs="${NODE_DIR}/src/domains/financial/scripts/${job}.sh"
  local log_file="${LOG_DIR}/${job}.cron.log"
  local service_path
  service_path="$(resolve_service_path)"

  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$script_abs")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$HOME")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$service_path")</string>
  </dict>
$(emit_schedule_intervals "$job")
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log_file")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log_file")</string>
</dict>
</plist>
EOF
}

case "$CMD" in
  print-plists)
    for job in "${JOBS[@]}"; do
      echo "=== ${PREFIX}.${job}.plist ==="
      generate_plist "$job"
    done
    ;;

  install)
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "schedule-macos.sh install requires macOS (launchd)." >&2
      exit 1
    fi
    mkdir -p "$LOG_DIR" "$PLIST_DIR"
    uid="$(id -u)"
    for job in "${JOBS[@]}"; do
      label="${PREFIX}.${job}"
      plist_path="${PLIST_DIR}/${label}.plist"
      generate_plist "$job" > "$plist_path"
      chmod 600 "$plist_path"
      plutil -lint "$plist_path" >/dev/null
      launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/${uid}" "$plist_path"
      echo "Installed ${label} -> ${plist_path}"
    done
    echo ""
    echo "Next: remove any duplicate snestack lines from 'crontab -e' so jobs don't run twice."
    ;;

  status)
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "schedule-macos.sh status requires macOS (launchd)." >&2
      exit 1
    fi
    uid="$(id -u)"
    for job in "${JOBS[@]}"; do
      label="${PREFIX}.${job}"
      plist_path="${PLIST_DIR}/${label}.plist"
      if info="$(launchctl print "gui/${uid}/${label}" 2>/dev/null)"; then
        last_exit="$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*last exit code = //p' | head -n 1)"
        echo "${label}: LOADED (last exit: ${last_exit:-unknown}, log: ${LOG_DIR}/${job}.cron.log, plist: ${plist_path})"
      else
        echo "${label}: NOT LOADED"
      fi
    done
    ;;

  uninstall)
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "schedule-macos.sh uninstall requires macOS (launchd)." >&2
      exit 1
    fi
    uid="$(id -u)"
    for job in "${JOBS[@]}"; do
      label="${PREFIX}.${job}"
      plist_path="${PLIST_DIR}/${label}.plist"
      launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1 || true
      rm -f "$plist_path"
      echo "Removed ${label}"
    done
    ;;

  help|-h|--help)
    sed -n '4,12p' "$0"
    ;;

  *)
    echo "Unknown command: $CMD" >&2
    exit 1
    ;;
esac
