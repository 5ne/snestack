import Anthropic from "@anthropic-ai/sdk";

export interface ExecutorResult {
  output: string;
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
  maxTokens = 1500
): Promise<ExecutorResult> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const output = response.content[0]?.type === "text" ? response.content[0].text : "";
  return { output };
}
