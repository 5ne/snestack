#!/usr/bin/env bash
set -euo pipefail

# Manage `snestack serve` (HTTP API + Web UI) as a user-level macOS LaunchAgent
# bound to 127.0.0.1:4700 by default, with optional Tailscale HTTPS proxy helpers.
#
# Usage:
#   ./scripts/service-macos.sh install [--addr 127.0.0.1:4700] [--skip-build]
#   ./scripts/service-macos.sh restart [--skip-build]
#   ./scripts/service-macos.sh status
#   ./scripts/service-macos.sh logs [--no-follow]
#   ./scripts/service-macos.sh uninstall
#   ./scripts/service-macos.sh print-plist [--addr 127.0.0.1:4700]
#   ./scripts/service-macos.sh tailscale-enable [--port 4700]
#   ./scripts/service-macos.sh tailscale-disable

LABEL="${SNESTACK_LAUNCHD_LABEL:-com.snestack.server}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$NODE_DIR/.." && pwd)"
WEB_DIR="$REPO_DIR/web"
LOG_DIR="${SNESTACK_SERVICE_LOG_DIR:-$NODE_DIR/logs}"
LOG_FILE="$LOG_DIR/snestack-serve.log"
PLIST_PATH="${SNESTACK_PLIST_PATH:-$HOME/Library/LaunchAgents/${LABEL}.plist}"

DEFAULT_ADDR="${SNESTACK_SERVE_ADDR:-127.0.0.1:4700}"
ADDR="$DEFAULT_ADDR"
SKIP_BUILD=0
NO_FOLLOW=0
TS_PORT="4700"

CMD="${1:-help}"
if [ $# -gt 0 ]; then
  shift
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --addr)
      ADDR="${2:?--addr requires host:port}"
      shift 2
      ;;
    --port)
      TS_PORT="${2:?--port requires port}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --no-follow)
      NO_FOLLOW=1
      shift
      ;;
    -h|--help|help)
      CMD="help"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}

resolve_node_bin() {
  if [ -n "${SNESTACK_NODE_BIN:-}" ]; then
    printf '%s' "$SNESTACK_NODE_BIN"
    return
  fi
  command -v node
}

generate_plist() {
  local node_bin
  node_bin="$(resolve_node_bin)"
  local node_bin_dir
  node_bin_dir="$(dirname "$node_bin")"
  local service_path="${node_bin_dir}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local cli_js="$NODE_DIR/dist/cli.js"

  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_bin")</string>
    <string>$(xml_escape "$cli_js")</string>
    <string>serve</string>
    <string>--addr</string>
    <string>$(xml_escape "$ADDR")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$NODE_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$service_path")</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
}

build_all() {
  if [ "$SKIP_BUILD" -eq 1 ]; then
    return
  fi
  if [ -d "$WEB_DIR" ]; then
    if [ ! -d "$WEB_DIR/node_modules" ]; then
      echo "Installing Web UI dependencies in $WEB_DIR..."
      npm --prefix "$WEB_DIR" install
    fi
    echo "Building Web UI..."
    npm --prefix "$WEB_DIR" run build
  fi
  echo "Building snestack server..."
  npm --prefix "$NODE_DIR" run build
}

extract_port() {
  printf '%s' "${ADDR##*:}"
}

wait_for_health() {
  local port
  port="$(extract_port)"
  local url="http://127.0.0.1:${port}/api/health"
  for _ in $(seq 1 20); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "✓ snestack serve is live at http://127.0.0.1:${port}"
      return 0
    fi
    sleep 0.25
  done
  echo "Warning: service loaded, but $url did not respond within 5s. Check logs: $LOG_FILE" >&2
  return 0
}

case "$CMD" in
  print-plist)
    generate_plist
    ;;

  install)
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "service-macos.sh install requires macOS (launchd)." >&2
      exit 1
    fi
    if [ ! -f "$NODE_DIR/.env" ]; then
      echo "Warning: $NODE_DIR/.env not found. Copy .env.example -> .env or run 'npm run dev -- setup' first." >&2
    fi
    build_all
    mkdir -p "$LOG_DIR" "$(dirname "$PLIST_PATH")"
    generate_plist > "$PLIST_PATH"
    chmod 600 "$PLIST_PATH"
    plutil -lint "$PLIST_PATH" >/dev/null

    uid="$(id -u)"
    launchctl bootout "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/${uid}" "$PLIST_PATH"
    launchctl kickstart -k "gui/${uid}/${LABEL}"
    echo "Installed LaunchAgent: $PLIST_PATH"
    wait_for_health
    echo ""
    echo "Optional Tailscale HTTPS access across your tailnet (keeps snestack bound to 127.0.0.1):"
    echo "  npm run service:tailscale"
    ;;

  restart)
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "service-macos.sh restart requires macOS (launchd)." >&2
      exit 1
    fi
    build_all
    uid="$(id -u)"
    launchctl kickstart -k "gui/${uid}/${LABEL}"
    echo "Restarted ${LABEL}."
    wait_for_health
    ;;

  status)
    port="$(extract_port)"
    if [ "$(uname -s)" = "Darwin" ]; then
      uid="$(id -u)"
      if launchctl print "gui/${uid}/${LABEL}" >/dev/null 2>&1; then
        echo "LaunchAgent ${LABEL}: LOADED ($PLIST_PATH)"
      else
        echo "LaunchAgent ${LABEL}: NOT LOADED"
      fi
    fi
    if health_json="$(curl -fsS "http://127.0.0.1:${port}/api/health" 2>/dev/null)"; then
      echo "Health (http://127.0.0.1:${port}/api/health): $health_json"
    else
      echo "Health (http://127.0.0.1:${port}/api/health): UNREACHABLE"
    fi
    if command -v tailscale >/dev/null 2>&1; then
      echo ""
      echo "Tailscale serve status:"
      tailscale serve status 2>/dev/null || echo "  (tailscale serve not active)"
    fi
    ;;

  logs)
    mkdir -p "$LOG_DIR"
    touch "$LOG_FILE"
    if [ "$NO_FOLLOW" -eq 1 ]; then
      tail -n 80 "$LOG_FILE"
    else
      tail -n 80 -f "$LOG_FILE"
    fi
    ;;

  uninstall)
    if [ "$(uname -s)" = "Darwin" ]; then
      uid="$(id -u)"
      launchctl bootout "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
    fi
    rm -f "$PLIST_PATH"
    echo "Uninstalled LaunchAgent ${LABEL}."
    ;;

  tailscale-enable)
    if ! command -v tailscale >/dev/null 2>&1; then
      echo "Tailscale CLI not found in PATH. Install Tailscale on macOS first (https://tailscale.com/download)." >&2
      exit 1
    fi
    echo "Configuring Tailscale HTTPS reverse proxy -> http://127.0.0.1:${TS_PORT} ..."
    echo "Tip: set SNESTACK_API_TOKEN in $NODE_DIR/.env (e.g. openssl rand -hex 32) for defense-in-depth."
    tailscale serve --bg "$TS_PORT"
    tailscale serve status
    ;;

  tailscale-disable)
    if ! command -v tailscale >/dev/null 2>&1; then
      echo "Tailscale CLI not found in PATH." >&2
      exit 1
    fi
    tailscale serve --https=443 off
    echo "Disabled Tailscale HTTPS proxy."
    ;;

  help|*)
    cat <<USAGE
Usage: ./scripts/service-macos.sh <command> [options]

Commands:
  install [--addr 127.0.0.1:4700] [--skip-build]   Build Web UI + server and load macOS LaunchAgent
  restart [--skip-build]                           Rebuild and restart the running LaunchAgent
  status                                           Check LaunchAgent, /api/health, and Tailscale status
  logs [--no-follow]                               Tail snestack-serve.log
  uninstall                                        Stop LaunchAgent and remove plist
  print-plist [--addr 127.0.0.1:4700]              Print generated LaunchAgent XML plist
  tailscale-enable [--port 4700]                   Expose 127.0.0.1:4700 privately on your Tailscale tailnet over HTTPS
  tailscale-disable                                Turn off Tailscale HTTPS proxy
USAGE
    ;;
esac
