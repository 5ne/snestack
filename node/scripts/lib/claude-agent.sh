#!/usr/bin/env bash
# Shared helper for the PM and eng role scripts: run an AGENTIC `claude -p` session
# (tools enabled, unlike the executor's text-only calls) on the owner's Claude
# subscription, from the repo root so CLAUDE.md loads.
#
#   run_claude_agent <prompt-file> <report-file> <max-turns> <allowed-tools> [extra claude args...]
#
# Writes the final message to <report-file> and the raw JSON next to it (<report-file>.json).
# Auth: CLAUDE_CODE_OAUTH_TOKEN only (from the environment or node/.env). ANTHROPIC_API_KEY /
# ANTHROPIC_AUTH_TOKEN are stripped so this can never silently bill the API, and there is NO API
# fallback here: an agentic session is not a single stateless call. A usage-limit or login
# failure exits 1 with a clear message and the next scheduled run simply tries again.
# Never add --bare (it ignores subscription credentials).
# Never push, merge or delete: those are denied below regardless of the prompt.

AGENT_DENY='Bash(git push*),Bash(git merge*),Bash(git reset --hard*),Bash(git clean*),Bash(rm *),Bash(sudo *),Bash(curl *),Bash(wget *),Read(./node/.env),Read(./.env),Read(**/.env),Edit(**/.env),Write(**/.env)'

run_claude_agent() {
  local prompt_file="$1" report="$2" max_turns="$3" allowed="$4"
  shift 4
  # The session runs from the repo root, so resolve relative paths against node/ (the callers' cwd) first.
  case "$prompt_file" in /*) ;; *) prompt_file="$NODE_DIR/$prompt_file" ;; esac
  case "$report" in /*) ;; *) report="$NODE_DIR/$report" ;; esac
  [ -f "$prompt_file" ] || { echo "prompt file not found: $prompt_file" >&2; return 2; }
  command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH ($PATH)" >&2; return 3; }
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$NODE_DIR/.env" ]; then
    CLAUDE_CODE_OAUTH_TOKEN="$(grep -m1 '^CLAUDE_CODE_OAUTH_TOKEN=' "$NODE_DIR/.env" | cut -d= -f2- || true)"
    export CLAUDE_CODE_OAUTH_TOKEN
  fi
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "CLAUDE_CODE_OAUTH_TOKEN not set (run 'claude setup-token', add it to node/.env)" >&2; return 4; }

  local rc=0
  (
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
    cd "$NODE_DIR/.." || exit 1
    claude -p \
      --model "${SNESTACK_AGENT_MODEL:-claude-sonnet-5-5}" \
      --output-format json \
      --permission-mode acceptEdits \
      --max-turns "$max_turns" \
      --allowedTools "$allowed" \
      --disallowedTools "$AGENT_DENY" \
      --add-dir "$BRAIN_ROOT" \
      "$@" < "$prompt_file" > "$report.json" 2> "$report.err"
  ) || rc=$?

  node -e '
    const fs = require("fs");
    const [json, out] = process.argv.slice(1);
    let d; try { d = JSON.parse(fs.readFileSync(json, "utf8")); } catch { console.error("claude returned non-JSON output"); process.exit(1); }
    fs.writeFileSync(out, (d.result || "") + "\n");
    const u = d.usage || {};
    console.error(`agent done: is_error=${d.is_error} turns=${d.num_turns} in=${u.input_tokens} out=${u.output_tokens} duration_ms=${d.duration_ms} (api-equivalent ~$${d.total_cost_usd}, not billed)`);
    if (d.is_error) { console.error("agent error: " + String(d.result).slice(0, 300)); process.exit(/usage limit|rate limit/i.test(String(d.result)) ? 5 : 1); }
  ' "$report.json" "$report" || rc=$?
  if [ "$rc" -ne 0 ]; then cat "$report.err" >&2 2>/dev/null || true; fi
  return "$rc"
}
