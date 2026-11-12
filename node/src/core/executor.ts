import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, getConfig, type ExecutorBackend, type ModelTier } from "./config";
import { ExecutorError } from "./errors";
import { logger } from "./logger";
import { estimateCostUsd, logRunEvent } from "./runLog";

export interface ExecutorResult {
  output: string;
  /** Why generation stopped — "max_tokens" here with an empty/truncated output means the
   * budget ran out before (or partway through) visible text, often to thinking content
   * that shares the same budget. Useful for diagnosing an empty output without re-running. */
  stopReason: string | null;
  outputTokensUsed: number | null;
  inputTokensUsed: number | null;
  model: string;
  latencyMs: number;
  /** Which backend in the chain produced this result. */
  backend?: ExecutorBackend;
  /** Set when an earlier backend in the chain failed and handed off (e.g. "agy-cli:usage_limit"). */
  fallbackFrom?: string;
}

export interface RunPromptOptions {
  /** Cost tier keyword; resolved to a concrete model by Config. Defaults to "normal". */
  tier?: ModelTier;
  maxTokens?: number;
  /** Human-readable identity of this call (e.g. "financial/long-term-quality INTU"), recorded in the run log. */
  label?: string;
  /** Internal: set when this call is a fallback from an earlier backend in the chain (recorded in the run log). */
  fallbackFrom?: string;
}

/**
 * Run a system + user prompt through the configured backend chain (`SNESTACK_EXECUTOR`,
 * e.g. `"agy-cli>fail"` or `"agy-cli>claude-cli>claude-api>fail"`) and return its raw text output.
 *
 * Supported backends:
 * - `"agy-cli"`: Antigravity CLI (`agy -p`) on the owner's Google AI Pro / Ultra subscription.
 * - `"claude-cli"`: Claude Code CLI (`claude -p`) on the owner's Claude subscription.
 * - `"api"` (`"claude-api"`): Metered Anthropic SDK (`@anthropic-ai/sdk`).
 *
 * Every call — success or failure — is recorded to the active run log (see core/runLog.ts)
 * with backend, model, token usage, latency, and stop reason. When a step fails with an
 * `ExecutorError` and another backend follows in the chain, `executor_fallback` is logged
 * and the next backend runs; when the chain ends (`>fail`), the error is rethrown cleanly.
 */
export async function runPrompt(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts: RunPromptOptions = {}
): Promise<ExecutorResult> {
  const config = getConfig();
  const chain = config.getExecutorChain();
  let fallbackFrom = opts.fallbackFrom;

  for (let i = 0; i < chain.length; i++) {
    const backend = chain[i];
    const stepOpts: RunPromptOptions = fallbackFrom ? { ...opts, fallbackFrom } : opts;
    try {
      if (backend === "agy-cli") {
        return await runPromptAgy(systemPrompt, userPrompt, stepOpts);
      }
      if (backend === "claude-cli") {
        return await runPromptCli(systemPrompt, userPrompt, stepOpts);
      }
      const resolvedKey = i === 0 && apiKey ? apiKey : apiKey || config.getClaudeApiKey();
      return await runPromptApi(resolvedKey, systemPrompt, userPrompt, stepOpts);
    } catch (e) {
      if (!(e instanceof ExecutorError) || i + 1 >= chain.length) {
        if (e instanceof ExecutorError) {
          logger.warn(
            `executor chain stopped at ${backend} (${config.getExecutorChainDisplay()}): [${e.code}] ${e.message}`.slice(0, 360)
          );
        }
        throw e;
      }
      const next = chain[i + 1];
      const reason = `[${e.code}] ${e.message}`.slice(0, 300);
      const nextDesc = next === "api" ? "the metered API" : next;
      logger.warn(`${backend} failed, falling back to ${nextDesc}: ${reason}`);
      logRunEvent("executor_fallback", {
        label: opts.label ?? null,
        from: backend,
        to: next,
        billing: next === "api" ? "metered" : "subscription",
        reason,
        error_code: e.code,
      });
      fallbackFrom = `${backend}:${e.code}`;
    }
  }
  throw new ExecutorError("Empty executor chain", "misconfigured_auth");
}

/** The pay-per-token backend (the original implementation, unchanged in behavior). */
export async function runPromptApi(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  { tier = "normal", maxTokens = 8000, label, fallbackFrom }: RunPromptOptions = {}
): Promise<ExecutorResult> {
  const model = getConfig().getModel(tier);
  const fallbackFields = fallbackFrom ? { fallback_from: fallbackFrom } : {};
  const started = Date.now();
  let response;
  try {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (e) {
    // An empty prepaid balance is the one failure that should stop the run outright: give it its own code.
    const exhausted = /credit balance is too low|insufficient[_ ]credit|billing/i.test(String(e));
    logRunEvent("model_call", {
      label: label ?? null,
      tier,
      model,
      backend: "api",
      ...fallbackFields,
      latency_ms: Date.now() - started,
      max_tokens: maxTokens,
      error: String(e).slice(0, 500),
      ...(exhausted ? { error_code: "api_credit_exhausted" } : {}),
    });
    if (exhausted) throw new ExecutorError(`Anthropic API credit exhausted: ${String(e).slice(0, 200)}`, "api_credit_exhausted");
    throw e;
  }

  const latencyMs = Date.now() - started;
  // Sonnet 5.5 / Opus 5.5 always think, so content can start with a thinking block and
  // max_tokens also covers the thinking — take every text block, not just content[0].
  const output = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const stopReason = response.stop_reason ?? null;
  const outputTokensUsed = response.usage?.output_tokens ?? null;
  const inputTokensUsed = response.usage?.input_tokens ?? null;

  logRunEvent("model_call", {
    label: label ?? null,
    tier,
    model,
    backend: "api",
    ...fallbackFields,
    input_tokens: inputTokensUsed,
    output_tokens: outputTokensUsed,
    max_tokens: maxTokens,
    stop_reason: stopReason,
    truncated: stopReason === "max_tokens",
    empty_output: output.length === 0,
    latency_ms: latencyMs,
  });

  return {
    output,
    stopReason,
    outputTokensUsed,
    inputTokensUsed,
    model,
    latencyMs,
    backend: "api",
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared CLI subprocess helpers
// ---------------------------------------------------------------------------

const DEFAULT_CLI_TIMEOUT_MS = 300_000;
/** Env vars that would make `claude -p` bill the API instead of the subscription (an API key always wins in -p mode). */
export const STRIPPED_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
/** Env vars that could route `agy` to a metered Gemini / AI Studio API key instead of Google AI Pro / Ultra OAuth. */
export const AGY_STRIPPED_ENV_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/** Child environment for `claude`: the parent's, minus anything that would switch billing to the metered API. */
export function buildCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of STRIPPED_ENV_VARS) delete env[k];
  return env;
}

/**
 * Child environment for `agy`: strips Gemini/Google API keys so `agy` only uses cached
 * Google AI Pro / Ultra OAuth credentials, and ensures `$HOME/.local/bin` (the default
 * `install.sh` target) is on `PATH` for minimal cron environments.
 */
export function buildAgyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of AGY_STRIPPED_ENV_VARS) delete env[k];
  if (env.HOME) {
    const localBin = path.join(env.HOME, ".local", "bin");
    const parts = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    if (!parts.includes(localBin)) {
      env.PATH = [...parts, localBin].join(path.delimiter);
    }
  }
  return env;
}

export function cliBinary(): string {
  return process.env.SNESTACK_CLAUDE_BIN || "claude";
}

export function agyBinary(): string {
  return process.env.SNESTACK_AGY_BIN || "agy";
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnSubprocess(
  bin: string,
  missingMsg: string,
  args: string[],
  stdin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new ExecutorError(missingMsg, "cli_missing"));
      } else {
        reject(new ExecutorError(`${bin} spawn failed (${err.code ?? "ERR"}): ${err.message}`, "cli_failed"));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => undefined); // CLI may exit before reading stdin
    child.stdin.end(stdin);
  });
}

const USAGE_LIMIT_RE = /usage limit|rate limit|limit reached|too many requests|\b429\b|quota|resource_exhausted/i;
const LOGIN_RE =
  /login expired|not logged in|not authenticated|authentication required|please run (\/login|agy login)|agy login|sign in|invalid (api key|token|credentials)|authentication|unauthorized|\b401\b/i;

/** Map a failed CLI result (message text) to a distinct error code. */
export function classifyCliFailure(text: string): "usage_limit" | "login_expired" | "cli_failed" {
  if (USAGE_LIMIT_RE.test(text)) return "usage_limit";
  if (LOGIN_RE.test(text)) return "login_expired";
  return "cli_failed";
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Extract a JSON object from CLI stdout. Handles clean JSON stdout as well as
 * CLIs that print update/status lines before the final JSON object envelope.
 */
export function parseJsonEnvelope(rawStdout: string): Record<string, unknown> | null {
  const cleaned = stripAnsi(rawStdout).trim();
  if (!cleaned) return null;
  try {
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // Fall through: check if leading non-JSON lines preceded the JSON object.
  }
  const lines = cleaned.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines.slice(i).join("\n").trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // keep scanning upward for the opening `{` of a multi-line JSON object
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// agy-cli backend (Google Antigravity CLI on Google AI Pro / Ultra OAuth)
// ---------------------------------------------------------------------------

// One agy call at a time per process, avoiding rate-window bursts during ticker loops.
let agyQueue: Promise<unknown> = Promise.resolve();
function serializeAgy<T>(fn: () => Promise<T>): Promise<T> {
  const next = agyQueue.then(fn, fn);
  agyQueue = next.catch(() => undefined);
  return next;
}

/**
 * Verify that the environment can use cached Google AI Pro / Ultra OAuth credentials
 * and isn't configured to force paid Gemini API key billing in `settings.json`.
 */
export function assertAgyAuth(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.HOME) {
    throw new ExecutorError(
      "agy-cli executor needs HOME set so `agy` can read your cached Google AI Pro/Ultra login (run `agy login`)",
      "not_logged_in"
    );
  }
  const settingsPath = path.join(env.HOME, ".gemini", "antigravity-cli", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (typeof settings.modelProvider === "string" && settings.modelProvider.trim().toLowerCase() === "gemini") {
        throw new ExecutorError(
          `${settingsPath} sets modelProvider="gemini" (paid API key mode); remove modelProvider so agy uses your Google AI Pro/Ultra OAuth login`,
          "misconfigured_auth"
        );
      }
    } catch (e) {
      if (e instanceof ExecutorError) throw e;
      // Ignore malformed settings.json here; let agy report its own config error if any.
    }
  }
}

/**
 * Google Antigravity CLI subscription backend: runs `agy -p` in an isolated temp dir with
 * `--sandbox` and `--disable-slash-commands`, Gemini/Google API keys stripped from child env,
 * diagnostics isolated on stderr, and structured JSON (or clean text) parsed from stdout.
 */
export function runPromptAgy(
  systemPrompt: string,
  userPrompt: string,
  { tier = "normal", maxTokens, label, fallbackFrom }: RunPromptOptions = {}
): Promise<ExecutorResult> {
  return serializeAgy(async () => {
    const config = getConfig();
    const configuredModel = config.getAgyModel(tier);
    const modelLabel = configuredModel ?? "agy-default";
    const fallbackFields = fallbackFrom ? { fallback_from: fallbackFrom } : {};
    const started = Date.now();
    const base = {
      label: label ?? null,
      tier,
      model: modelLabel,
      backend: "agy-cli",
      billing: "subscription",
      max_tokens: maxTokens ?? null,
      ...fallbackFields,
    };
    const fail = (err: ExecutorError): never => {
      logRunEvent("model_call", {
        ...base,
        latency_ms: Date.now() - started,
        error: `[${err.code}] ${err.message}`.slice(0, 500),
        error_code: err.code,
      });
      throw err;
    };

    try {
      assertAgyAuth();
    } catch (e) {
      return fail(e as ExecutorError);
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-agy-"));
    try {
      const outputFormat = (process.env.SNESTACK_AGY_OUTPUT_FORMAT ?? "json").trim().toLowerCase();
      const extra = (process.env.SNESTACK_AGY_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);

      // Keep -p argument well below OS ARG_MAX by piping large payloads over stdin.
      const inlineSystem = systemPrompt.trim().length > 0 && systemPrompt.length <= 4000;
      const promptArg = inlineSystem
        ? systemPrompt
        : "Follow the system instructions and respond to the user prompt provided on stdin.";
      const stdinPayload = inlineSystem
        ? userPrompt
        : [systemPrompt.trim() ? `SYSTEM INSTRUCTIONS:\n${systemPrompt.trim()}\n` : "", userPrompt].filter(Boolean).join("\n");

      const args = [
        "-p",
        promptArg,
        ...(configuredModel ? ["--model", configuredModel] : []),
        ...(outputFormat === "text" ? [] : ["--output-format", "json"]),
        "--disable-slash-commands",
        "--sandbox",
        ...extra,
      ];
      const timeoutMs = Number(process.env[Config.CLI_TIMEOUT_MS]) || DEFAULT_CLI_TIMEOUT_MS;
      const bin = agyBinary();

      let run: CliRun;
      try {
        run = await spawnSubprocess(
          bin,
          `agy CLI not found (${bin}); install via 'curl -fsSL https://antigravity.google/cli/install.sh | bash' and run 'agy' once to sign in, or set SNESTACK_AGY_BIN`,
          args,
          stdinPayload,
          workDir,
          buildAgyEnv(),
          timeoutMs
        );
      } catch (e) {
        if (e instanceof ExecutorError) return fail(e);
        throw e;
      }
      if (run.timedOut) return fail(new ExecutorError(`agy CLI timed out after ${timeoutMs}ms`, "timeout"));

      const cleanStderr = stripAnsi(run.stderr).trim();

      if (outputFormat === "text") {
        const cleanStdout = stripAnsi(run.stdout);
        if (run.code !== 0) {
          const text = `${cleanStderr} ${cleanStdout}`.trim();
          return fail(new ExecutorError(`agy CLI failed (exit ${run.code}): ${text.slice(0, 300)}`, classifyCliFailure(text)));
        }
        const output = cleanStdout.trim();
        const latencyMs = Date.now() - started;
        logRunEvent("model_call", {
          ...base,
          input_tokens: null,
          output_tokens: null,
          stop_reason: "end_turn",
          truncated: false,
          empty_output: output.length === 0,
          latency_ms: latencyMs,
          est_cost_usd: 0,
          api_equivalent_usd: null,
        });
        return {
          output,
          stopReason: "end_turn",
          outputTokensUsed: null,
          inputTokensUsed: null,
          model: modelLabel,
          latencyMs,
          backend: "agy-cli",
          ...(fallbackFrom ? { fallbackFrom } : {}),
        };
      }

      const parsed = parseJsonEnvelope(run.stdout);
      const statusStr = typeof parsed?.status === "string" ? parsed.status.toUpperCase() : null;
      const statusFailed = statusStr !== null && !["SUCCESS", "OK", "DONE", "COMPLETED"].includes(statusStr);
      const hasErrorField = typeof parsed?.error === "string" && parsed.error.trim().length > 0;

      if (run.code !== 0 || parsed?.is_error === true || statusFailed || hasErrorField) {
        const errDetail = [
          typeof parsed?.error === "string" ? parsed.error : "",
          typeof parsed?.response === "string" ? parsed.response : "",
          typeof parsed?.result === "string" ? parsed.result : "",
          cleanStderr,
          parsed ? "" : stripAnsi(run.stdout).trim(),
        ]
          .filter(Boolean)
          .join(" ")
          .trim();
        return fail(new ExecutorError(`agy CLI failed (exit ${run.code}): ${errDetail.slice(0, 300)}`, classifyCliFailure(errDetail)));
      }
      if (!parsed) {
        return fail(new ExecutorError("agy CLI returned non-JSON output on stdout", "bad_output"));
      }

      const output =
        typeof parsed.response === "string"
          ? parsed.response
          : typeof parsed.result === "string"
            ? parsed.result
            : "";
      const usage = (parsed.usage ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
      // agy reports input_tokens + cache_read_tokens; accept Claude-style cache_* keys too if present.
      const inputParts = [
        usage.input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
      ].map(num);
      const inputTokensUsed = inputParts.some((v) => v != null) ? inputParts.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
      const outputTokensUsed = num(usage.output_tokens);
      const reportedModel = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : modelLabel;
      const stopReason =
        typeof parsed.stop_reason === "string"
          ? parsed.stop_reason
          : typeof parsed.status === "string"
            ? parsed.status
            : null;
      const durationSec = num(parsed.duration_seconds);
      const latencyMs =
        durationSec != null ? Math.round(durationSec * 1000) : (num(parsed.duration_ms) ?? Date.now() - started);
      const apiEquivalent =
        inputTokensUsed != null && outputTokensUsed != null
          ? estimateCostUsd(reportedModel, inputTokensUsed, outputTokensUsed)
          : null;

      logRunEvent("model_call", {
        ...base,
        model: reportedModel,
        input_tokens: inputTokensUsed,
        output_tokens: outputTokensUsed,
        stop_reason: stopReason,
        truncated: stopReason === "max_tokens",
        empty_output: output.length === 0,
        latency_ms: latencyMs,
        est_cost_usd: 0,
        api_equivalent_usd: apiEquivalent,
      });

      return {
        output,
        stopReason,
        outputTokensUsed,
        inputTokensUsed,
        model: reportedModel,
        latencyMs,
        backend: "agy-cli",
        ...(fallbackFrom ? { fallbackFrom } : {}),
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// claude-cli backend
// ---------------------------------------------------------------------------

// One CLI call at a time per process, so a per-ticker loop never bursts the plan's rate window.
let cliQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = cliQueue.then(fn, fn);
  cliQueue = next.catch(() => undefined);
  return next;
}

/** Fail fast, before any call, when there is no subscription credential to use. */
export function assertCliAuth(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new ExecutorError(
      "claude-cli executor needs CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`, put it in node/.env); refusing to run unauthenticated",
      "not_logged_in"
    );
  }
}

/** Subscription backend: `claude -p` with tools disabled, run from an empty temp dir, API keys stripped from the child env. */
export function runPromptCli(
  systemPrompt: string,
  userPrompt: string,
  { tier = "normal", maxTokens, label, fallbackFrom }: RunPromptOptions = {}
): Promise<ExecutorResult> {
  return serialize(async () => {
    const config = getConfig();
    const model = config.getCliModel(tier);
    const fallbackFields = fallbackFrom ? { fallback_from: fallbackFrom } : {};
    const started = Date.now();
    const base = {
      label: label ?? null,
      tier,
      model,
      backend: "claude-cli",
      billing: "subscription",
      max_tokens: maxTokens ?? null,
      ...fallbackFields,
    };
    const fail = (err: ExecutorError): never => {
      logRunEvent("model_call", {
        ...base,
        latency_ms: Date.now() - started,
        error: `[${err.code}] ${err.message}`.slice(0, 500),
        error_code: err.code,
      });
      throw err;
    };

    try {
      assertCliAuth();
    } catch (e) {
      return fail(e as ExecutorError);
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-cli-"));
    try {
      const sysFile = path.join(workDir, "system.txt");
      fs.writeFileSync(sysFile, systemPrompt);
      const extra = (process.env.SNESTACK_CLI_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);
      // Do NOT add --bare: it ignores subscription OAuth credentials.
      const args = ["-p", "--model", model, "--output-format", "json", "--tools", "", "--system-prompt-file", sysFile, ...extra];
      const timeoutMs = Number(process.env[Config.CLI_TIMEOUT_MS]) || DEFAULT_CLI_TIMEOUT_MS;
      const bin = cliBinary();

      let run: CliRun;
      try {
        run = await spawnSubprocess(
          bin,
          `claude CLI not found (${bin}); install Claude Code or set SNESTACK_CLAUDE_BIN`,
          args,
          userPrompt,
          workDir,
          buildCliEnv(),
          timeoutMs
        );
      } catch (e) {
        if (e instanceof ExecutorError) return fail(e);
        throw e;
      }
      if (run.timedOut) return fail(new ExecutorError(`claude CLI timed out after ${timeoutMs}ms`, "timeout"));

      const parsed = parseJsonEnvelope(run.stdout);

      if (run.code !== 0 || parsed?.is_error === true) {
        const text = `${typeof parsed?.result === "string" ? parsed.result : ""} ${stripAnsi(run.stderr)} ${parsed ? "" : stripAnsi(run.stdout)}`.trim();
        return fail(new ExecutorError(`claude CLI failed (exit ${run.code}): ${text.slice(0, 300)}`, classifyCliFailure(text)));
      }
      if (!parsed) return fail(new ExecutorError("claude CLI returned non-JSON output", "bad_output"));

      const output = typeof parsed.result === "string" ? parsed.result : "";
      const usage = (parsed.usage ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
      // Cached input still counts as input for the api-equivalent estimate.
      const inputParts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(num);
      const inputTokensUsed = inputParts.some((v) => v != null) ? inputParts.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
      const outputTokensUsed = num(usage.output_tokens);
      const stopReason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : typeof parsed.subtype === "string" ? parsed.subtype : null;
      const latencyMs = num(parsed.duration_ms) ?? Date.now() - started;
      const apiEquivalent =
        inputTokensUsed != null && outputTokensUsed != null ? estimateCostUsd(model, inputTokensUsed, outputTokensUsed) : null;

      logRunEvent("model_call", {
        ...base,
        input_tokens: inputTokensUsed,
        output_tokens: outputTokensUsed,
        stop_reason: stopReason,
        truncated: stopReason === "max_tokens",
        empty_output: output.length === 0,
        latency_ms: latencyMs,
        // Not a real charge: the subscription is flat-rate. Kept so run-check can still see usage trends.
        est_cost_usd: 0,
        api_equivalent_usd: apiEquivalent,
      });
      return {
        output,
        stopReason,
        outputTokensUsed,
        inputTokensUsed,
        model,
        latencyMs,
        backend: "claude-cli",
        ...(fallbackFrom ? { fallbackFrom } : {}),
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}
