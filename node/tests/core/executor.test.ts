import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const create = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create } })),
}));

import { runPrompt } from "../../src/core/executor";
import { readRunEvents } from "../../src/core/runLog";

describe("runPrompt run logging", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-exec-"));
    process.env.SNESTACK_RUN_DIR = dir;
    process.env.SNESTACK_RUN_ID = "run-x";
    create.mockReset();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.SNESTACK_RUN_DIR;
    delete process.env.SNESTACK_RUN_ID;
  });

  it("records model, tier, tokens, latency and stop reason for a successful call", async () => {
    create.mockResolvedValue({
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 45 },
    });
    const result = await runPrompt("k", "sys", "user", { tier: "cheap", label: "financial/x INTU" });
    expect(result.output).toBe("hello");
    expect(result.inputTokensUsed).toBe(120);
    const [e] = readRunEvents(dir);
    expect(e).toMatchObject({
      event: "model_call",
      label: "financial/x INTU",
      tier: "cheap",
      input_tokens: 120,
      output_tokens: 45,
      stop_reason: "end_turn",
      truncated: false,
      empty_output: false,
    });
    expect(typeof e.model).toBe("string");
    expect(typeof e.latency_ms).toBe("number");
  });

  it("flags truncation and empty output", async () => {
    create.mockResolvedValue({
      content: [{ type: "thinking", thinking: "" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 8000 },
    });
    await runPrompt("k", "sys", "user");
    expect(readRunEvents(dir)[0]).toMatchObject({ truncated: true, empty_output: true, stop_reason: "max_tokens" });
  });

  it("records a failed call and rethrows", async () => {
    create.mockRejectedValue(new Error("401 invalid x-api-key"));
    await expect(runPrompt("k", "sys", "user", { label: "financial/x GOOG" })).rejects.toThrow("401");
    const [e] = readRunEvents(dir);
    expect(e.event).toBe("model_call");
    expect(e.label).toBe("financial/x GOOG");
    expect(String(e.error)).toContain("401");
  });
});
