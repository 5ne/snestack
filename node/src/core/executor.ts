import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, getConfig, type ModelTier } from "./config";
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
}

export interface RunPromptOptions {
  /** Cost tier keyword; resolved to a concrete model by Config.getModel(). Defaults to "normal". */
  tier?: ModelTier;
  maxTokens?: number;
  /** Human-readable identity of this call (e.g. "financial/long-term-quality INTU"), recorded in the run log. */
  label?: string;
  /** Internal: set when this API call is a fallback from another backend (recorded in the run log). */
  fallbackFrom?: string;
}

/**
 * Run a system + user prompt through the model and return its raw text output.
 * Dispatches on SNESTACK_EXECUTOR: "api" (default, the Anthropic SDK, metered) or
 * "claude-cli" (`claude -p` on the owner's subscription). Both backends return the
 * same ExecutorResult and log the same `model_call` event (plus `backend`).
 *
 * Every call — success or failure — is recorded to the active run log (see
 * core/runLog.ts) with the model, token usage, latency and stop reason, so a
 * truncated or failed call is visible without re-running anything.
 */
export async function runPrompt(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts: RunPromptOptions = {}
): Promise<ExecutorResult> {
  const config = getConfig();
  if (config.getExecutorBackend() !== "claude-cli") return runPromptApi(apiKey, systemPrompt, userPrompt, opts);
  try {
    return await runPromptCli(systemPrompt, userPrompt, opts);
  } catch (e) {
    if (!(e instanceof ExecutorError) || !config.isApiFallbackEnabled()) throw e;
    // Fall back to the metered API, but never silently: warn, log an executor_fallback event, and tag the
    // model_call so run.json / run-check / the finalize line all show that this run spent real money.
    const reason = `[${e.code}] ${e.message}`.slice(0, 300);
    logger.warn(`claude-cli failed, falling back to the metered API: ${reason}`);
    logRunEvent("executor_fallback", { label: opts.label ?? null, from: "claude-cli", to: "api", reason, error_code: e.code });
    return runPromptApi(apiKey || config.getClaudeApiKey(), systemPrompt, userPrompt, { ...opts, fallbackFrom: `claude-cli:${e.code}` });
  }
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

  return { output, stopReason, outputTokensUsed, inputTokensUsed, model, latencyMs };
}

// ---------------------------------------------------------------------------
// claude-cli backend
// ---------------------------------------------------------------------------

const DEFAULT_CLI_TIMEOUT_MS = 300_000;
/** Env vars that would make `claude -p` bill the API instead of the subscription (an API key always wins in -p mode). */
export const STRIPPED_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Child environment for the CLI: the parent's, minus anything that would switch billing to the metered API. */
export function buildCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of STRIPPED_ENV_VARS) delete env[k];
  return env;
}

export function cliBinary(): string {
  return process.env.SNESTACK_CLAUDE_BIN || "claude";
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnCli(args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliBinary(), args, { cwd, env: buildCliEnv(), stdio: ["pipe", "pipe", "pipe"] });
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
        reject(new ExecutorError(`claude CLI not found (${cliBinary()}); install Claude Code or set SNESTACK_CLAUDE_BIN`, "cli_missing"));
      } else reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => undefined); // CLI may exit before reading stdin
    child.stdin.end(stdin);
  });
}

const USAGE_LIMIT_RE = /usage limit|rate limit|limit reached|too many requests|\b429\b|quota/i;
const LOGIN_RE = /login expired|not logged in|please run \/login|invalid (api key|token|credentials)|authentication|unauthorized|\b401\b/i;

/** Map a failed CLI result (message text) to a distinct error code. */
export function classifyCliFailure(text: string): "usage_limit" | "login_expired" | "cli_failed" {
  if (USAGE_LIMIT_RE.test(text)) return "usage_limit";
  if (LOGIN_RE.test(text)) return "login_expired";
  return "cli_failed";
}

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
  { tier = "normal", maxTokens, label }: RunPromptOptions = {}
): Promise<ExecutorResult> {
  return serialize(async () => {
    const config = getConfig();
    const model = config.getCliModel(tier);
    const started = Date.now();
    const base = { label: label ?? null, tier, model, backend: "claude-cli", billing: "subscription", max_tokens: maxTokens ?? null };
    const fail = (err: ExecutorError): never => {
      logRunEvent("model_call", { ...base, latency_ms: Date.now() - started, error: `[${err.code}] ${err.message}`.slice(0, 500), error_code: err.code });
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

      let run: CliRun;
      try {
        run = await spawnCli(args, userPrompt, workDir, timeoutMs);
      } catch (e) {
        if (e instanceof ExecutorError) return fail(e);
        throw e;
      }
      if (run.timedOut) return fail(new ExecutorError(`claude CLI timed out after ${timeoutMs}ms`, "timeout"));

      let parsed: Record<string, unknown> | null = null;
      try {
        const p = JSON.parse(run.stdout);
        if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
      } catch {
        // handled below
      }

      if (run.code !== 0 || parsed?.is_error === true) {
        const text = `${typeof parsed?.result === "string" ? parsed.result : ""} ${run.stderr} ${parsed ? "" : run.stdout}`.trim();
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
      return { output, stopReason, outputTokensUsed, inputTokensUsed, model, latencyMs };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
}
