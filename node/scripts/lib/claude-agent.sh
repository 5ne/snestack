#!/usr/bin/env bash
# Shared helper for the PM and eng role scripts: run an AGENTIC CLI session
# (tools enabled, unlike the executor's isolated text-only calls) on the owner's
# subscription, honoring the CLI chain in SNESTACK_EXECUTOR (e.g. "agy-cli>fail"
# or "agy-cli>claude-cli>fail"; metered API steps are ignored here because agentic
# sessions need local tools).
#
#   run_claude_agent <prompt-file> <report-file> <max-turns> <allowed-tools> [extra claude args...]
#
# Writes the final message to <report-file> and the raw JSON next to it (<report-file>.json).
# Auth guards:
# - agy-cli: uses cached Google AI Pro/Ultra OAuth login ($HOME/.gemini/); GEMINI_API_KEY and
#   GOOGLE_API_KEY are stripped so it can never silently bill a paid API key.
# - claude-cli: uses CLAUDE_CODE_OAUTH_TOKEN only; ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN
#   are stripped, and --bare is never passed.
# Never push, merge or delete: enforced via Claude's --disallowedTools and AGY's --sandbox + prompt guardrails.

AGENT_DENY='Bash(git push*),Bash(git merge*),Bash(git reset --hard*),Bash(git clean*),Bash(rm *),Bash(sudo *),Bash(curl *),Bash(wget *),Read(./node/.env),Read(./.env),Read(**/.env),Edit(**/.env),Write(**/.env)'

_run_single_agy_agent() {
  local prompt_file="$1" report="$2"
  local agy_bin="${SNESTACK_AGY_BIN:-agy}"
  if ! command -v "$agy_bin" >/dev/null 2>&1; then
    if [ -n "${HOME:-}" ] && [ -x "$HOME/.local/bin/agy" ] && [ "$agy_bin" = "agy" ]; then
      agy_bin="$HOME/.local/bin/agy"
    else
      echo "agy CLI not found on PATH ($PATH); install via 'curl -fsSL https://antigravity.google/cli/install.sh | bash' and run 'agy login'" | tee "$report.err" >&2
      return 3
    fi
  fi
  if [ -z "${HOME:-}" ]; then
    echo "HOME not set; agy needs HOME to read cached Google AI Pro/Ultra OAuth credentials" | tee "$report.err" >&2
    return 4
  fi

  local rc=0
  (
    unset GEMINI_API_KEY GOOGLE_API_KEY
    cd "$NODE_DIR/.." || exit 1
    agy_args=(
      -p "Follow the autonomous role instructions provided on stdin. Hard safety rules: never run git push, git merge, git reset --hard, git clean, rm, sudo, curl, or wget, and never read, print, edit, or write any .env file."
      --mode auto
      --sandbox
      --disable-slash-commands
      --output-format json
    )
    if [ -n "${SNESTACK_AGY_AGENT_MODEL:-}" ]; then
      agy_args+=(--model "$SNESTACK_AGY_AGENT_MODEL")
    fi
    "$agy_bin" "${agy_args[@]}" < "$prompt_file" > "$report.json" 2> "$report.err"
  ) || rc=$?

  node -e '
    const fs = require("fs");
    const [jsonPath, outPath, exitCodeStr] = process.argv.slice(1);
    const exitCode = Number(exitCodeStr) || 0;
    const raw = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim() : "";
    let d = null;
    if (raw) {
      try { d = JSON.parse(raw); } catch {
        const lines = raw.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const c = lines.slice(i).join("\n").trim();
          if (!c.startsWith("{")) continue;
          try { d = JSON.parse(c); break; } catch {}
        }
      }
    }
    if (!d || typeof d !== "object") {
      console.error("agy returned non-JSON output (exit " + exitCode + ")");
      process.exit(exitCode || 1);
    }
    const status = typeof d.status === "string" ? d.status.toUpperCase() : "SUCCESS";
    const isErr = exitCode !== 0 || d.is_error === true || Boolean(d.error) || !["SUCCESS", "OK", "DONE", "COMPLETED"].includes(status);
    const text = typeof d.response === "string" ? d.response : (typeof d.result === "string" ? d.result : "");
    fs.writeFileSync(outPath, text + "\n");
    const u = d.usage || {};
    const durMs = typeof d.duration_seconds === "number" ? Math.round(d.duration_seconds * 1000) : d.duration_ms;
    console.error(`agy agent done: status=${status} turns=${d.num_turns ?? "?"} in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} duration_ms=${durMs ?? "?"} (subscription, not billed)`);
    if (isErr) {
      const msg = String(d.error || text || status).slice(0, 300);
      console.error("agy agent error: " + msg);
      process.exit(/usage limit|rate limit|quota|429|resource_exhausted/i.test(msg) ? 5 : 1);
    }
  ' "$report.json" "$report" "$rc" || rc=$?
  if [ "$rc" -ne 0 ]; then cat "$report.err" >&2 2>/dev/null || true; fi
  return "$rc"
}

_run_single_claude_agent() {
  local prompt_file="$1" report="$2" max_turns="$3" allowed="$4"
  shift 4
  command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH ($PATH)" | tee "$report.err" >&2; return 3; }
  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$NODE_DIR/.env" ]; then
    CLAUDE_CODE_OAUTH_TOKEN="$(grep -m1 '^CLAUDE_CODE_OAUTH_TOKEN=' "$NODE_DIR/.env" | cut -d= -f2- || true)"
    export CLAUDE_CODE_OAUTH_TOKEN
  fi
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "CLAUDE_CODE_OAUTH_TOKEN not set (run 'claude setup-token', add it to node/.env)" | tee "$report.err" >&2; return 4; }

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

run_claude_agent() {
  local prompt_file="$1" report="$2" max_turns="$3" allowed="$4"
  shift 4
  # The session runs from the repo root, so resolve relative paths against node/ (the callers' cwd) first.
  case "$prompt_file" in /*) ;; *) prompt_file="$NODE_DIR/$prompt_file" ;; esac
  case "$report" in /*) ;; *) report="$NODE_DIR/$report" ;; esac
  [ -f "$prompt_file" ] || { echo "prompt file not found: $prompt_file" >&2; return 2; }

  local raw_exec="${SNESTACK_EXECUTOR:-}"
  if [ -z "$raw_exec" ] && [ -f "$NODE_DIR/.env" ]; then
    raw_exec="$(grep -m1 '^SNESTACK_EXECUTOR=' "$NODE_DIR/.env" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  fi
  raw_exec="${raw_exec:-claude-cli}"

  # Extract CLI backends in chain order (agy-cli, claude-cli); metered API steps never apply to tool-enabled agent runs.
  local cli_steps=()
  local IFS_SAVE="$IFS"
  IFS='>'
  for step in $raw_exec; do
    step="$(echo "$step" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$step" in
      agy-cli|claude-cli) cli_steps+=("$step") ;;
      fail) break ;;
      *) ;;
    esac
  done
  IFS="$IFS_SAVE"
  [ "${#cli_steps[@]}" -gt 0 ] || cli_steps=("claude-cli")

  local last_rc=1
  local idx=0
  local total="${#cli_steps[@]}"
  for backend in "${cli_steps[@]}"; do
    idx=$((idx + 1))
    last_rc=0
    if [ "$backend" = "agy-cli" ]; then
      _run_single_agy_agent "$prompt_file" "$report" || last_rc=$?
    else
      _run_single_claude_agent "$prompt_file" "$report" "$max_turns" "$allowed" "$@" || last_rc=$?
    fi
    [ "$last_rc" -eq 0 ] && return 0
    if [ "$idx" -lt "$total" ]; then
      echo "WARN: $backend agent session failed (exit $last_rc); falling back to next CLI in chain (${cli_steps[$idx]})" >&2
    fi
  done
  return "$last_rc"
}
