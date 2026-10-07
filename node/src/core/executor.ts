import Anthropic from "@anthropic-ai/sdk";
import { getConfig, type ModelTier } from "./config";
import { logRunEvent } from "./runLog";

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
}

/**
 * Run a system + user prompt through the model and return its raw text output.
 * Deliberately thin — a skill's judgment is expressed in prose, so this does
 * not try to parse or enforce a structured response shape. Uses the raw
 * Anthropic SDK rather than the Claude Agent SDK: the Agent SDK currently
 * requires zod v4, which this project isn't on (see core/models.ts's zod v3
 * schemas) — revisit once that bump happens naturally.
 *
 * Every call — success or failure — is recorded to the active run log (see
 * core/runLog.ts) with the model, token usage, latency and stop reason, so a
 * truncated or failed call is visible without re-running anything.
 */
export async function runPrompt(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  { tier = "normal", maxTokens = 8000, label }: RunPromptOptions = {}
): Promise<ExecutorResult> {
  const model = getConfig().getModel(tier);
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
    logRunEvent("model_call", {
      label: label ?? null,
      tier,
      model,
      latency_ms: Date.now() - started,
      max_tokens: maxTokens,
      error: String(e).slice(0, 500),
    });
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
