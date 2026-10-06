import Anthropic from "@anthropic-ai/sdk";
import { getConfig, type ModelTier } from "./config";

export interface ExecutorResult {
  output: string;
}

export interface RunPromptOptions {
  /** Cost tier keyword; resolved to a concrete model by Config.getModel(). Defaults to "normal". */
  tier?: ModelTier;
  maxTokens?: number;
}

/**
 * Run a system + user prompt through the model and return its raw text output.
 * Deliberately thin — a skill's judgment is expressed in prose, so this does
 * not try to parse or enforce a structured response shape. Uses the raw
 * Anthropic SDK rather than the Claude Agent SDK: the Agent SDK currently
 * requires zod v4, which this project isn't on (see core/models.ts's zod v3
 * schemas) — revisit once that bump happens naturally.
 */
export async function runPrompt(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  { tier = "normal", maxTokens = 8000 }: RunPromptOptions = {}
): Promise<ExecutorResult> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: getConfig().getModel(tier),
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  // Sonnet 5.5 / Opus 5.5 always think, so content can start with a thinking block and
  // max_tokens also covers the thinking — take every text block, not just content[0].
  const output = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { output };
}
