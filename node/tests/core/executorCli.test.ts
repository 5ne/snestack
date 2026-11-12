import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const create = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create } })),
}));

import {
  assertAgyAuth,
  buildAgyEnv,
  buildCliEnv,
  classifyCliFailure,
  parseJsonEnvelope,
  runPrompt,
} from "../../src/core/executor";
import { parseExecutorChain } from "../../src/core/config";
import { ExecutorError } from "../../src/core/errors";
import { evaluateRuns } from "../../src/core/runCheck";
import { finalizeRun, readRunEvents, summarizeRun } from "../../src/core/runLog";

/** Writes a fake CLI executable (`claude` or `agy`); `body` is a shell snippet that runs with stdin = the prompt. */
function fakeBin(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function fakeClaude(dir: string, body: string): string {
  return fakeBin(dir, "claude", body);
}

function fakeAgy(dir: string, body: string): string {
  return fakeBin(dir, "agy", body);
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
  it("needs no API key for claude-cli or agy-cli unless a metered fallback is required", async () => {
    const { getConfig } = await import("../../src/core/config");
    delete process.env.SNESTACK_CLAUDE_API_KEY;
    process.env.SNESTACK_EXECUTOR = "claude-cli";
    expect(getConfig().getExecutorApiKey()).toBe("");
    process.env.SNESTACK_EXECUTOR = "agy-cli>fail";
    expect(getConfig().getExecutorApiKey()).toBe("");
  });

  it("parses ordered executor chains and rejects invalid chains", () => {
    expect(parseExecutorChain("agy-cli>fail")).toEqual(["agy-cli"]);
    expect(parseExecutorChain("agy-cli>claude-cli>fail")).toEqual(["agy-cli", "claude-cli"]);
    expect(parseExecutorChain("agy-cli>claude-cli>claude-api>fail")).toEqual(["agy-cli", "claude-cli", "api"]);
    expect(parseExecutorChain("agy-cli")).toEqual(["agy-cli"]);
    expect(parseExecutorChain("claude-cli")).toEqual(["claude-cli", "api"]);
    expect(parseExecutorChain("claude-cli", "none")).toEqual(["claude-cli"]);
    expect(parseExecutorChain("claude-api")).toEqual(["api"]);

    expect(() => parseExecutorChain("fail")).toThrow();
    expect(() => parseExecutorChain("agy-cli>fail>claude-cli")).toThrow();
    expect(() => parseExecutorChain("agy-cli>>fail")).toThrow();
    expect(() => parseExecutorChain("agy-cli>agy-cli>fail")).toThrow();
    expect(() => parseExecutorChain("claude-api>api>fail")).toThrow();
    expect(() => parseExecutorChain("agy-cli>unknown>fail")).toThrow();
  });
});

const AGY_OK_JSON = JSON.stringify({
  conversation_id: "conv-123",
  status: "SUCCESS",
  response: "agy answer\nVERDICT: BUY | 0.85 | intact moat",
  duration_seconds: 1.5,
  num_turns: 1,
  usage: {
    input_tokens: 800,
    cache_read_tokens: 200,
    output_tokens: 50,
    thinking_tokens: 30,
    total_tokens: 1050,
  },
});

describe("runPrompt agy-cli backend and fallback chains", () => {
  let dir: string;
  let fakeHome: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-agy-test-"));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-agy-home-"));
    process.env.HOME = fakeHome;
    process.env.SNESTACK_RUN_DIR = dir;
    process.env.SNESTACK_RUN_ID = "run-agy";
    process.env.SNESTACK_EXECUTOR = "agy-cli>fail";
    delete process.env.SNESTACK_EXECUTOR_FALLBACK;
    delete process.env.SNESTACK_AGY_OUTPUT_FORMAT;
    delete process.env.SNESTACK_AGY_MODEL_CHEAP;
    delete process.env.SNESTACK_AGY_MODEL_NORMAL;
    create.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it("parses agy JSON envelope, logs subscription billing with $0 cost, and isolates stderr", async () => {
    process.env.SNESTACK_AGY_MODEL_CHEAP = "gemini-2.5-pro";
    process.env.SNESTACK_AGY_BIN = fakeAgy(
      dir,
      `cat >/dev/null; echo 'diagnostic notice' >&2; printf '%s\\n' '${AGY_OK_JSON}'`
    );
    const r = await runPrompt("", "sys", "user", { tier: "cheap", label: "financial/long-term-quality NVDA" });
    expect(r.output).toBe("agy answer\nVERDICT: BUY | 0.85 | intact moat");
    expect(r.backend).toBe("agy-cli");
    expect(r.model).toBe("gemini-2.5-pro");
    expect(r.inputTokensUsed).toBe(1000);
    expect(r.outputTokensUsed).toBe(50);
    expect(r.latencyMs).toBe(1500);
    expect(create).not.toHaveBeenCalled();

    const e = readRunEvents(dir).find((x) => x.event === "model_call")!;
    expect(e).toMatchObject({
      backend: "agy-cli",
      billing: "subscription",
      est_cost_usd: 0,
      label: "financial/long-term-quality NVDA",
    });
    expect(e.api_equivalent_usd).toBeCloseTo((1000 * 1.25 + 50 * 10) / 1e6, 8);
  });

  it("handles banner/ANSI noise before JSON on stdout and supports text output format", async () => {
    expect(parseJsonEnvelope(`\u001b[32mUpdating...\u001b[0m\n${AGY_OK_JSON}`)).toMatchObject({
      status: "SUCCESS",
    });

    process.env.SNESTACK_AGY_OUTPUT_FORMAT = "text";
    process.env.SNESTACK_AGY_BIN = fakeAgy(
      dir,
      `cat >/dev/null; echo 'progress...' >&2; printf '\\033[36mclean text reply\\033[0m\\n'`
    );
    const r = await runPrompt("", "sys", "user");
    expect(r.output).toBe("clean text reply");
  });

  it("strips GEMINI_API_KEY and GOOGLE_API_KEY, appends ~/.local/bin to PATH, and passes safe flags", async () => {
    process.env.GEMINI_API_KEY = "AIza-secret-1";
    process.env.GOOGLE_API_KEY = "AIza-secret-2";
    const envOut = path.join(dir, "agy-env.txt");
    const argsOut = path.join(dir, "agy-args.txt");
    process.env.SNESTACK_AGY_BIN = fakeAgy(
      dir,
      `echo "$@" > '${argsOut}'; cat >> '${argsOut}'; env > '${envOut}'; printf '%s\\n' '${AGY_OK_JSON}'`
    );

    await runPrompt("", "sys-instruction", "the-user-payload");
    const seenEnv = fs.readFileSync(envOut, "utf8");
    expect(seenEnv).not.toMatch(/GEMINI_API_KEY|GOOGLE_API_KEY/);
    expect(seenEnv).toContain(path.join(fakeHome, ".local", "bin"));

    const seenArgs = fs.readFileSync(argsOut, "utf8");
    expect(seenArgs).toContain("-p sys-instruction --output-format json --disable-slash-commands --sandbox");
    expect(seenArgs).toContain("the-user-payload");

    const built = buildAgyEnv({ GEMINI_API_KEY: "x", GOOGLE_API_KEY: "y", HOME: "/Users/test", PATH: "/usr/bin" });
    expect(built.GEMINI_API_KEY).toBeUndefined();
    expect(built.GOOGLE_API_KEY).toBeUndefined();
    expect(built.PATH).toBe("/usr/bin:/Users/test/.local/bin");
  });

  it("refuses to run if settings.json forces modelProvider=gemini or HOME is missing", async () => {
    const cfgDir = path.join(fakeHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "settings.json"), JSON.stringify({ modelProvider: "gemini" }));
    process.env.SNESTACK_AGY_BIN = path.join(dir, "never-spawned");
    await expect(runPrompt("", "sys", "user")).rejects.toMatchObject({ code: "misconfigured_auth" });

    expect(() => assertAgyAuth({})).toThrow(ExecutorError);
  });

  it("fails gracefully without fallback when SNESTACK_EXECUTOR=agy-cli>fail", async () => {
    process.env.SNESTACK_EXECUTOR = "agy-cli>fail";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    const claudeTouched = path.join(dir, "claude-touched");
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `touch '${claudeTouched}'; echo '${OK_JSON}'`);
    process.env.SNESTACK_AGY_BIN = fakeAgy(
      dir,
      `cat >/dev/null; echo 'Authentication required: run agy login' >&2; exit 1`
    );

    await expect(runPrompt("", "sys", "user")).rejects.toMatchObject({ code: "login_expired" });
    expect(fs.existsSync(claudeTouched)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(readRunEvents(dir).filter((e) => e.event === "executor_fallback")).toHaveLength(0);
  });

  it("falls back agy-cli -> claude-cli on subscription without triggering metered api_fallback warnings", async () => {
    process.env.SNESTACK_EXECUTOR = "agy-cli>claude-cli>fail";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.SNESTACK_AGY_BIN = fakeAgy(
      dir,
      `cat >/dev/null; echo '{"status":"ERROR","error":"429 quota exceeded"}'; exit 1`
    );
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(dir, `cat >/dev/null; echo '${OK_JSON}'`);

    logRunEventCompat(dir);
    const r = await runPrompt("", "sys", "user", { label: "financial/x AAPL" });
    expect(r.output).toBe("hello VERDICT: HOLD");
    expect(r.backend).toBe("claude-cli");
    expect(r.fallbackFrom).toBe("agy-cli:usage_limit");
    expect(create).not.toHaveBeenCalled();

    const events = readRunEvents(dir);
    expect(events.find((e) => e.event === "executor_fallback")).toMatchObject({
      from: "agy-cli",
      to: "claude-cli",
      billing: "subscription",
      error_code: "usage_limit",
    });

    const summary = finalizeRun(dir, 0);
    expect(summary.model_calls.est_cost_usd).toBe(0);
    expect(summary.model_calls.subscription_fallbacks).toBe(1);
    expect(summary.model_calls.api_fallbacks).toBe(0);

    // Ensure run-check does NOT emit a false "real spend" api_fallback warning for subscription->subscription fallback
    const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-rc-"));
    try {
      const dayDir = path.join(runsRoot, "2026-11-11");
      fs.mkdirSync(dayDir, { recursive: true });
      // Clear the initial agy usage_limit only to isolate the fallback check, or check api_fallback specifically:
      fs.copyFileSync(path.join(dir, "run.json"), path.join(dayDir, "run.json"));
      const findings = evaluateRuns({
        now: new Date(2026, 10, 11, 18, 0, 0),
        days: 1,
        expectations: [{ name: "financial", runsRoot, expectedOn: () => true, graceHour: 8 }],
      });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it("walks the full agy-cli>claude-cli>claude-api>fail chain when both CLIs fail", async () => {
    process.env.SNESTACK_EXECUTOR = "agy-cli>claude-cli>claude-api>fail";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.SNESTACK_CLAUDE_API_KEY = "sk-ant-fallback-key";
    process.env.SNESTACK_AGY_BIN = fakeAgy(dir, `cat >/dev/null; echo '429 rate limit' >&2; exit 1`);
    process.env.SNESTACK_CLAUDE_BIN = fakeClaude(
      dir,
      `cat >/dev/null; echo '{"is_error":true,"result":"Claude usage limit reached"}'; exit 1`
    );
    create.mockResolvedValue({
      content: [{ type: "text", text: "metered rescue" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const r = await runPrompt("", "sys", "user", { label: "financial/x MSFT" });
    expect(r.output).toBe("metered rescue");
    expect(r.backend).toBe("api");
    expect(r.fallbackFrom).toBe("claude-cli:usage_limit");

    const events = readRunEvents(dir);
    const fallbacks = events.filter((e) => e.event === "executor_fallback");
    expect(fallbacks).toHaveLength(2);
    expect(fallbacks[0]).toMatchObject({ from: "agy-cli", to: "claude-cli", billing: "subscription" });
    expect(fallbacks[1]).toMatchObject({ from: "claude-cli", to: "api", billing: "metered" });

    const s = summarizeRun(events);
    expect(s.model_calls.api_fallbacks).toBe(1);
    expect(s.model_calls.est_cost_usd).toBeGreaterThan(0);
  });
});

function logRunEventCompat(dir: string): void {
  fs.appendFileSync(
    path.join(dir, "run.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), run_id: "run-agy", event: "run_start", script: "test" }) + "\n"
  );
}
