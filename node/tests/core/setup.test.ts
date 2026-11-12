import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import prompts from "prompts";
import { setupInteractive, validateEnv } from "../../src/core/setup";
import { resetConfig, getConfig } from "../../src/core/config";

// A path guaranteed not to exist, so tests never pick up the developer's
// real .env (which may have valid keys already set) from process.cwd().
const NO_ENV = "/nonexistent/.env";

const SNESTACK_VARS = [
  "SNESTACK_FINNHUB_API_KEY",
  "SNESTACK_CLAUDE_API_KEY",
  "SNESTACK_GMAIL_ADDRESS",
  "SNESTACK_GMAIL_APP_PASSWORD",
  "SNESTACK_NOTIFICATION_EMAIL",
  "SNESTACK_BRAIN_ROOT",
  "SNESTACK_TWILIO_ACCOUNT_SID",
  "SNESTACK_TWILIO_AUTH_TOKEN",
  "SNESTACK_SMS_PHONE",
];

function clearEnv() {
  SNESTACK_VARS.forEach((k) => delete process.env[k]);
}

describe("setupInteractive", () => {
  let tmpDir: string;
  let envFile: string;

  beforeEach(() => {
    resetConfig();
    clearEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-setup-"));
    envFile = path.join(tmpDir, ".env");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    resetConfig();
    clearEnv();
  });

  it("writes a valid config to .env without Twilio", async () => {
    prompts.inject([
      "validfinnhubkeyabc", // finnhub key
      "sk-ant-validclaudekey123", // claude key
      "me@gmail.com", // gmail address
      "app-password-123", // gmail app password
      "notify@example.com", // notification email
      false, // setupTwilio
      true, // confirmSave
    ]);
    const ok = await setupInteractive(envFile);
    expect(ok).toBe(true);
    const written = fs.readFileSync(envFile, "utf8");
    expect(written).toContain("SNESTACK_FINNHUB_API_KEY=validfinnhubkeyabc");
    expect(written).toContain("SNESTACK_CLAUDE_API_KEY=sk-ant-validclaudekey123");
    expect(written).toContain("SNESTACK_GMAIL_ADDRESS=me@gmail.com");
    expect(written).toContain("SNESTACK_NOTIFICATION_EMAIL=notify@example.com");
    expect(written).not.toContain("TWILIO");
  });

  it("rejects an invalid Finnhub key and doesn't write a file", async () => {
    prompts.inject(["short"]);
    const ok = await setupInteractive(envFile);
    expect(ok).toBe(false);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("does not save when the user declines the final confirmation", async () => {
    prompts.inject([
      "validfinnhubkeyabc",
      "sk-ant-validclaudekey123",
      "me@gmail.com",
      "app-password-123",
      "notify@example.com",
      false,
      false, // confirmSave
    ]);
    const ok = await setupInteractive(envFile);
    expect(ok).toBe(false);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("saves Twilio credentials when configured", async () => {
    const sid = "AC" + "1".repeat(32);
    const token = "a".repeat(31);
    prompts.inject([
      "validfinnhubkeyabc",
      "sk-ant-validclaudekey123",
      "me@gmail.com",
      "app-password-123",
      "notify@example.com",
      true, // setupTwilio
      sid,
      token,
      "+15551234567",
      true, // confirmSave
    ]);
    const ok = await setupInteractive(envFile);
    expect(ok).toBe(true);
    const written = fs.readFileSync(envFile, "utf8");
    expect(written).toContain(`SNESTACK_TWILIO_ACCOUNT_SID=${sid}`);
    expect(written).toContain(`SNESTACK_TWILIO_AUTH_TOKEN=${token}`);
    expect(written).toContain("SNESTACK_SMS_PHONE=+15551234567");
  });

  it("skips Twilio entirely when declined", async () => {
    prompts.inject([
      "validfinnhubkeyabc",
      "sk-ant-validclaudekey123",
      "me@gmail.com",
      "app-password-123",
      "notify@example.com",
      false, // setupTwilio
      true,
    ]);
    const ok = await setupInteractive(envFile);
    expect(ok).toBe(true);
    const written = fs.readFileSync(envFile, "utf8");
    expect(written).not.toContain("SNESTACK_TWILIO_ACCOUNT_SID");
    expect(written).not.toContain("SNESTACK_SMS_PHONE");
  });
});

describe("validateEnv", () => {
  beforeEach(() => {
    resetConfig();
    clearEnv();
  });

  afterEach(() => {
    resetConfig();
    clearEnv();
  });

  it("returns false when required vars are missing", () => {
    // Seed the singleton against a non-existent .env first, so validateEnv's
    // internal getConfig() call doesn't fall back to loading a real .env
    // from process.cwd() (which may have valid keys already set).
    getConfig(NO_ENV);
    expect(validateEnv()).toBe(false);
  });

  it("returns true when all required vars are present", () => {
    process.env.SNESTACK_FINNHUB_API_KEY = "validfinnhubkeyabc";
    process.env.SNESTACK_CLAUDE_API_KEY = "sk-ant-validclaudekey123";
    process.env.SNESTACK_GMAIL_ADDRESS = "me@gmail.com";
    process.env.SNESTACK_NOTIFICATION_EMAIL = "notify@example.com";
    getConfig(NO_ENV);
    expect(validateEnv()).toBe(true);
  });

  it("does not require SNESTACK_CLAUDE_API_KEY when SNESTACK_EXECUTOR uses agy-cli>fail", () => {
    process.env.SNESTACK_FINNHUB_API_KEY = "validfinnhubkeyabc";
    process.env.SNESTACK_EXECUTOR = "agy-cli>fail";
    process.env.SNESTACK_GMAIL_ADDRESS = "me@gmail.com";
    process.env.SNESTACK_NOTIFICATION_EMAIL = "notify@example.com";
    getConfig(NO_ENV);
    try {
      expect(validateEnv()).toBe(true);
    } finally {
      delete process.env.SNESTACK_EXECUTOR;
    }
  });
});
