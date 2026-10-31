import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const create = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create } })),
}));

import { buildCliEnv, classifyCliFailure, runPrompt } from "../../src/core/executor";
import { ExecutorError } from "../../src/core/errors";
import { readRunEvents, summarizeRun } from "../../src/core/runLog";

/** Writes a fake `claude` executable; `body` is a shell snippet that runs with stdin = the prompt. */
function fakeClaude(dir: string, body: string): string {
  const file = path.join(dir, "claude");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const OK_JSON = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hello VERDICT: HOLD",
  duration_ms: 1234,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
});

describe("runPrompt claude-cli backend", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-cli-test-"));
    process.env.SNESTACK_RUN_DIR = dir;
    process.env.SNESTACK_RUN_ID = "run-cli";
    process.env.SNESTACK_EXECUTOR = "claude-cli";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    delete process.env.SNESTACK_EXECUTOR_FALLBACK;
    create.mockReset();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it("returns output and logs a subscription model_call with api_equivalent_usd", async () => {
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `cat >/dev/null; echo '${OK_JSON}'`);
    const r = await runPrompt("", "sys", "user", { tier: "cheap", label: "financial/x INTU" });
    expect(r.output).toBe("hello VERDICT: HOLD");
    expect(r.inputTokensUsed).toBe(1000);
    expect(r.outputTokensUsed).toBe(20);
    expect(create).not.toHaveBeenCalled();
    const e = readRunEvents(dir).find((x) => x.event === "model_call")!;
    expect(e).toMatchObject({ backend: "claude-cli", billing: "subscription", est_cost_usd: 0, label: "financial/x INTU" });
    expect(e.api_equivalent_usd).toBeCloseTo((1000 * 1 + 20 * 5) / 1e6, 8);
    const s = summarizeRun(readRunEvents(dir));
    expect(s.model_calls.est_cost_usd).toBe(0);
    expect(s.model_calls.api_equivalent_usd).toBeGreaterThan(0);
  });

  it("strips ANTHROPIC_API_KEY / AUTH_TOKEN from the child env but keeps the OAuth token", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "leak2";
    const out = path.join(dir, "env.txt");
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `cat >/dev/null; env > '${out}'; echo '${OK_JSON}'`);
    await runPrompt("", "sys", "user");
    const env = fs.readFileSync(out, "utf8");
    expect(env).not.toMatch(/ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/);
    expect(env).toMatch(/CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test/);
    expect(buildCliEnv({ ANTHROPIC_API_KEY: "x", A: "1" })).toEqual({ A: "1" });
  });

  it("passes tools-disabled args, never --bare, and the user prompt on stdin", async () => {
    const out = path.join(dir, "args.txt");
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `echo "$@" > '${out}'; cat >> '${out}'; echo '${OK_JSON}'`);
    await runPrompt("", "sys", "the-user-prompt", { tier: "normal" });
    const seen = fs.readFileSync(out, "utf8");
    expect(seen).toContain("-p --model claude-sonnet-5-5 --output-format json --tools ");
    expect(seen).not.toContain("--bare");
    expect(seen).toContain("the-user-prompt");
  });

  const LIMIT_BIN = `cat >/dev/null; echo '{"is_error":true,"result":"Claude usage limit reached"}'; exit 1`;
  const API_OK = { content: [{ type: "text", text: "api answer" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };

  it("falls back to the metered API on a usage limit and reports it in the log and summary", async () => {
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, LIMIT_BIN);
    process.env.SNESTACK_CLAUDE_API_KEY = "sk-test-key";
    create.mockResolvedValue(API_OK);
    const r = await runPrompt("", "sys", "user", { label: "financial/x INTU" });
    expect(r.output).toBe("api answer");
    const events = readRunEvents(dir);
    expect(events.find((e) => e.event === "executor_fallback")).toMatchObject({ from: "claude-cli", to: "api", error_code: "usage_limit" });
    const calls = events.filter((e) => e.event === "model_call");
    expect(calls[0]).toMatchObject({ backend: "claude-cli", error_code: "usage_limit" });
    expect(calls[1]).toMatchObject({ backend: "api", fallback_from: "claude-cli:usage_limit" });
    const s = summarizeRun(events);
    expect(s.model_calls.api_fallbacks).toBe(1);
    expect(s.model_calls.est_cost_usd).toBeGreaterThan(0);
  });

  it("does not fall back when SNESTACK_EXECUTOR_FALLBACK=none", async () => {
    process.env.SNESTACK_EXECUTOR_FALLBACK = "none";
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, LIMIT_BIN);
    await expect(runPrompt("", "sys", "user")).rejects.toMatchObject({ code: "usage_limit" });
    expect(create).not.toHaveBeenCalled();
  });

  it("stops with api_credit_exhausted when the fallback API account has no credit", async () => {
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, LIMIT_BIN);
    process.env.SNESTACK_CLAUDE_API_KEY = "sk-test-key";
    create.mockRejectedValue(new Error("400 Your credit balance is too low to access the Anthropic API"));
    await expect(runPrompt("", "sys", "user")).rejects.toMatchObject({ code: "api_credit_exhausted" });
    expect(summarizeRun(readRunEvents(dir)).model_calls.api_credit_exhausted).toBe(1);
  });

  it("fails with a clear error when the fallback is needed but no API key is configured", async () => {
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, LIMIT_BIN);
    delete process.env.SNESTACK_CLAUDE_API_KEY;
    await expect(runPrompt("", "sys", "user")).rejects.toThrow(/SNESTACK_CLAUDE_API_KEY/);
  });

  it("rejects non-JSON output, login expiry, timeout and a missing binary with distinct codes", async () => {
    process.env.SNESTACK_EXECUTOR_FALLBACK = "none";
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `cat >/dev/null; echo 'not json'`);
    await expect(runPrompt("", "s", "u")).rejects.toMatchObject({ code: "bad_output" });

    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `cat >/dev/null; echo 'Login expired, please run /login' >&2; exit 1`);
    await expect(runPrompt("", "s", "u")).rejects.toMatchObject({ code: "login_expired" });

    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `cat >/dev/null; exec sleep 5`);
    process.env.SNESTACK_CLI_TIMEOUT_MS = "200";
    await expect(runPrompt("", "s", "u")).rejects.toMatchObject({ code: "timeout" });
    delete process.env.SNESTACK_CLI_TIMEOUT_MS;

    process.env.SNESTACK_CLAUDE_BIN = path.join(dir, "does-not-exist");
    await expect(runPrompt("", "s", "u")).rejects.toMatchObject({ code: "cli_missing" });
  });

  it("refuses to run without CLAUDE_CODE_OAUTH_TOKEN, before spawning anything", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.SNESTACK_EXECUTOR_FALLBACK = "none";
    process.env.SNESTACK_CLAUDE_BIN = path.join(dir, "never-called");
    const err = await runPrompt("", "s", "u").catch((e) => e);
    expect(err).toBeInstanceOf(ExecutorError);
    expect(err.code).toBe("not_logged_in");
  });

  it("runs calls one at a time", async () => {
    const log = path.join(dir, "order.txt");
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `cat >/dev/null; echo start >> '${log}'; sleep 0.3; echo end >> '${log}'; echo '${OK_JSON}'`);
    await Promise.all([runPrompt("", "s", "u"), runPrompt("", "s", "u")]);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end"]);
  });

  it("classifies failure text", () => {
    expect(classifyCliFailure("5-hour usage limit reached")).toBe("usage_limit");
    expect(classifyCliFailure("Login expired")).toBe("login_expired");
    expect(classifyCliFailure("boom")).toBe("cli_failed");
  });
});

describe("executor backend selection", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("defaults to the api backend and rejects unknown values", async () => {
    const { getConfig } = await import("../../src/core/config");
    delete process.env.SNESTACK_EXECUTOR;
    expect(getConfig().getExecutorBackend()).toBe("api");
    process.env.SNESTACK_EXECUTOR = "nope";
    expect(() => getConfig().getExecutorBackend()).toThrow();
  });
  it("needs no API key for claude-cli unless a fallback is required", async () => {
    const { getConfig } = await import("../../src/core/config");
    delete process.env.SNESTACK_CLAUDE_API_KEY;
    process.env.SNESTACK_EXECUTOR = "claude-cli";
    expect(getConfig().getExecutorApiKey()).toBe("");
  });
});
