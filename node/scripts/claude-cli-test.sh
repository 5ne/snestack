#!/usr/bin/env bash
# Smoke test for running a model call through the Claude Code CLI (`claude -p`)
# on the owner's subscription instead of the pay-per-token API. Not wired into
# the harness: it only proves the CLI is installed, authenticated and answers.
#
# Usage: claude-cli-test.sh [--model cheap|normal|expensive|<model-id>] "<prompt>"
#   --model  tier name (mapped to the same defaults as core/config.ts, each
#            overridable with SNESTACK_MODEL_CHEAP|NORMAL|EXPENSIVE) or a full
#            model id. Default: cheap.
#   prompt   required; the text sent to the model (or pipe it on stdin).
#
# Auth: reads only CLAUDE_CODE_OAUTH_TOKEN from node/.env (never the whole file),
# and removes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so the call cannot
# silently bill the API (in -p mode an API key always wins over a subscription).
# Tools are disabled and the CLI runs from an empty temp dir, so it cannot read
# or edit anything. Do not add --bare: it ignores subscription credentials.
set -euo pipefail

MODEL="cheap"
PROMPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:-}"; [ -n "$MODEL" ] || { echo "--model needs a value" >&2; exit 2; }; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    --*) echo "Unknown argument: $1" >&2; exit 2 ;;
    *) PROMPT="${PROMPT:+$PROMPT }$1" ;;
  esac
  shift
done
if [ -z "$PROMPT" ] && [ ! -t 0 ]; then PROMPT="$(cat)"; fi
if [ -z "$PROMPT" ]; then echo "Usage: $0 [--model cheap|normal|expensive|<model-id>] \"<prompt>\"" >&2; exit 2; fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$MODEL" in
  cheap)     MODEL_ID="${SNESTACK_MODEL_CHEAP:-claude-haiku-4-5-20251001}" ;;
  normal)    MODEL_ID="${SNESTACK_MODEL_NORMAL:-claude-sonnet-5-5}" ;;
  expensive) MODEL_ID="${SNESTACK_MODEL_EXPENSIVE:-claude-opus-5-5}" ;;
  *)         MODEL_ID="$MODEL" ;;
esac

command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH ($PATH)" >&2; exit 3; }

# Take only the subscription token from .env, unless it is already exported.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$NODE_DIR/.env" ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(grep -m1 '^CLAUDE_CODE_OAUTH_TOKEN=' "$NODE_DIR/.env" | cut -d= -f2- || true)"
  export CLAUDE_CODE_OAUTH_TOKEN
fi
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "CLAUDE_CODE_OAUTH_TOKEN not set (run 'claude setup-token' and add it to node/.env)" >&2
  exit 4
fi
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

echo "model: $MODEL_ID  (auth: subscription token, API key stripped)" >&2
START=$(date +%s)
set +e
OUT="$(printf '%s' "$PROMPT" | claude -p --model "$MODEL_ID" --output-format json --tools "" 2>"$WORKDIR/err")"
CODE=$?
set -e
ELAPSED=$(( $(date +%s) - START ))

if [ $CODE -ne 0 ]; then
  echo "claude exited $CODE after ${ELAPSED}s" >&2
  cat "$WORKDIR/err" >&2
  printf '%s\n' "$OUT" >&2
  exit $CODE
fi

if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$OUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit("non-JSON output from claude")
print(d.get("result", ""))
u = d.get("usage", {})
print("---\nis_error=%s  in=%s out=%s  duration_ms=%s  cost_usd(estimate, not billed)=%s" % (
    d.get("is_error"), u.get("input_tokens"), u.get("output_tokens"), d.get("duration_ms"), d.get("total_cost_usd")), file=sys.stderr)
sys.exit(1 if d.get("is_error") else 0)
'
else
  printf '%s\n' "$OUT"
fi
echo "done in ${ELAPSED}s" >&2
