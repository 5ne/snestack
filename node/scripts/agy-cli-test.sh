#!/usr/bin/env bash
# Smoke test for running a model call through the Google Antigravity CLI (`agy -p`)
# on the owner's Google AI Pro / Ultra subscription instead of a paid API key.
#
# Usage: agy-cli-test.sh [--model cheap|normal|expensive|<model-id>] "<prompt>"
#   --model  optional tier name (reads SNESTACK_AGY_MODEL_CHEAP|NORMAL|EXPENSIVE if set)
#            or an explicit model id from `agy models`. Omit to use `agy`'s active default model.
#   prompt   required; the text sent to the model (or pipe it on stdin).
#
# Auth: uses cached Google AI Pro / Ultra OAuth credentials in macOS Keychain / $HOME/.gemini/
# (initialized automatically on first launch of `agy` or shared with Antigravity desktop).
# GEMINI_API_KEY and GOOGLE_API_KEY are stripped so the call can never silently
# bill a metered Gemini / AI Studio API key. Runs inside an empty temp dir with
# --sandbox and --disable-slash-commands.
set -euo pipefail

MODEL=""
PROMPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="${2:-}"; [ -n "$MODEL" ] || { echo "--model needs a value" >&2; exit 2; }; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    --*) echo "Unknown argument: $1" >&2; exit 2 ;;
    *) PROMPT="${PROMPT:+$PROMPT }$1" ;;
  esac
  shift
done
if [ -z "$PROMPT" ] && [ ! -t 0 ]; then PROMPT="$(cat)"; fi
if [ -z "$PROMPT" ]; then echo "Usage: $0 [--model cheap|normal|expensive|<model-id>] \"<prompt>\"" >&2; exit 2; fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

MODEL_ID=""
case "$MODEL" in
  "")        MODEL_ID="" ;;
  cheap)     MODEL_ID="${SNESTACK_AGY_MODEL_CHEAP:-}" ;;
  normal)    MODEL_ID="${SNESTACK_AGY_MODEL_NORMAL:-}" ;;
  expensive) MODEL_ID="${SNESTACK_AGY_MODEL_EXPENSIVE:-}" ;;
  *)         MODEL_ID="$MODEL" ;;
esac

AGY_BIN="${SNESTACK_AGY_BIN:-agy}"
command -v "$AGY_BIN" >/dev/null 2>&1 || {
  echo "agy CLI not found on PATH ($PATH); install via 'curl -fsSL https://antigravity.google/cli/install.sh | bash' and run 'agy' once to sign in" >&2
  exit 3
}
[ -n "${HOME:-}" ] || { echo "HOME not set; agy needs HOME to read cached OAuth credentials" >&2; exit 4; }

unset GEMINI_API_KEY GOOGLE_API_KEY

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

ARGS=(-p "Respond directly and concisely to the prompt provided on stdin." --output-format json --disable-slash-commands --sandbox)
[ -n "$MODEL_ID" ] && ARGS+=(--model "$MODEL_ID")

echo "model: ${MODEL_ID:-agy-default}  (auth: Google AI Pro/Ultra OAuth, Gemini API keys stripped)" >&2
START=$(date +%s)
set +e
OUT="$(printf '%s' "$PROMPT" | "$AGY_BIN" "${ARGS[@]}" 2>"$WORKDIR/err")"
CODE=$?
set -e
ELAPSED=$(( $(date +%s) - START ))

if [ $CODE -ne 0 ]; then
  echo "agy exited $CODE after ${ELAPSED}s" >&2
  cat "$WORKDIR/err" >&2
  printf '%s\n' "$OUT" >&2
  exit $CODE
fi

printf '%s' "$OUT" | node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(0, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  let d = null;
  try { d = JSON.parse(raw); } catch {
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const c = lines.slice(i).join("\n").trim();
      if (!c.startsWith("{")) continue;
      try { d = JSON.parse(c); break; } catch {}
    }
  }
  if (!d) { console.error("non-JSON output from agy"); process.exit(1); }
  process.stdout.write((d.response ?? d.result ?? "") + "\n");
  const u = d.usage || {};
  console.error(`---\nstatus=${d.status ?? "ok"}  in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"}  duration_s=${d.duration_seconds ?? "?"}  cost_usd=0 (Google AI Pro/Ultra subscription)`);
  if (d.error || d.is_error) process.exit(1);
'
echo "done in ${ELAPSED}s" >&2
