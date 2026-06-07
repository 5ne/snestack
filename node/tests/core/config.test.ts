import { Config, getConfig, resetConfig } from "../../src/core/config";
import { ConfigError, ValidationError } from "../../src/core/errors";

// Pass a non-existent env file so dotenv never loads the real .env
const NO_ENV = "/nonexistent/.env";

const FSTACK_VARS = [
  "FSTACK_FINNHUB_API_KEY",
  "FSTACK_CLAUDE_API_KEY",
  "FSTACK_GMAIL_ADDRESS",
  "FSTACK_GMAIL_APP_PASSWORD",
  "FSTACK_NOTIFICATION_EMAIL",
  "FSTACK_DATABASE_PATH",
  "FSTACK_TWILIO_ACCOUNT_SID",
  "FSTACK_TWILIO_AUTH_TOKEN",
  "FSTACK_SMS_PHONE",
];

beforeEach(() => {
  resetConfig();
  FSTACK_VARS.forEach((k) => delete process.env[k]);
});

describe("Config.get", () => {
  it("returns env var value", () => {
    process.env.FSTACK_DATABASE_PATH = "test.db";
    expect(Config.get("FSTACK_DATABASE_PATH")).toBe("test.db");
  });

  it("returns default when env var missing", () => {
    expect(Config.get("FSTACK_MISSING", "default")).toBe("default");
  });

  it("returns undefined when no default", () => {
    expect(Config.get("FSTACK_MISSING")).toBeUndefined();
  });
});

describe("Config.require", () => {
  it("returns value when set", () => {
    process.env.FSTACK_FINNHUB_API_KEY = "test_key_12345";
    expect(Config.require("FSTACK_FINNHUB_API_KEY")).toBe("test_key_12345");
  });

  it("throws ConfigError when missing", () => {
    expect(() => Config.require("FSTACK_MISSING_KEY")).toThrow(ConfigError);
  });
});

describe("getDatabasePath", () => {
  it("returns default when not set", () => {
    const config = new Config(NO_ENV);
    expect(config.getDatabasePath()).toBe("../fstack.db");
  });

  it("returns custom path when set", () => {
    process.env.FSTACK_DATABASE_PATH = "/tmp/test.db";
    const config = new Config(NO_ENV);
    expect(config.getDatabasePath()).toBe("/tmp/test.db");
  });
});

describe("getFinnhubApiKey", () => {
  it("returns key when valid", () => {
    process.env.FSTACK_FINNHUB_API_KEY = "validkeyabcde";
    const config = new Config(NO_ENV);
    expect(config.getFinnhubApiKey()).toBe("validkeyabcde");
  });

  it("throws ValidationError for short key", () => {
    process.env.FSTACK_FINNHUB_API_KEY = "short";
    const config = new Config(NO_ENV);
    expect(() => config.getFinnhubApiKey()).toThrow(ValidationError);
  });

  it("throws ConfigError when missing", () => {
    const config = new Config(NO_ENV);
    expect(() => config.getFinnhubApiKey()).toThrow(ConfigError);
  });
});

describe("getClaudeApiKey", () => {
  it("returns key with sk- prefix", () => {
    process.env.FSTACK_CLAUDE_API_KEY = "sk-ant-test1234567890";
    const config = new Config(NO_ENV);
    expect(config.getClaudeApiKey()).toBe("sk-ant-test1234567890");
  });

  it("throws ValidationError without sk- prefix", () => {
    process.env.FSTACK_CLAUDE_API_KEY = "invalid-key-no-prefix";
    const config = new Config(NO_ENV);
    expect(() => config.getClaudeApiKey()).toThrow(ValidationError);
  });
});

describe("getTwilioCredentials", () => {
  it("returns undefined pair when neither set", () => {
    const config = new Config(NO_ENV);
    const [sid, token] = config.getTwilioCredentials();
    expect(sid).toBeUndefined();
    expect(token).toBeUndefined();
  });

  it("returns values when both set", () => {
    process.env.FSTACK_TWILIO_ACCOUNT_SID = "ACxxxxxxxxxx";
    process.env.FSTACK_TWILIO_AUTH_TOKEN = "authtoken123";
    const config = new Config(NO_ENV);
    const [sid, token] = config.getTwilioCredentials();
    expect(sid).toBe("ACxxxxxxxxxx");
    expect(token).toBe("authtoken123");
  });

  it("throws ConfigError when only one is set", () => {
    process.env.FSTACK_TWILIO_ACCOUNT_SID = "ACxxxxxxxxxx";
    const config = new Config(NO_ENV);
    expect(() => config.getTwilioCredentials()).toThrow(ConfigError);
  });
});

describe("Config.validateApiKey", () => {
  it("validates finnhub keys", () => {
    expect(Config.validateApiKey("validfinnhubkey", "finnhub")).toBe(true);
    expect(Config.validateApiKey("short", "finnhub")).toBe(false);
  });

  it("validates claude keys", () => {
    expect(Config.validateApiKey("sk-ant-valid-key-12345", "claude")).toBe(true);
    expect(Config.validateApiKey("invalid-no-prefix", "claude")).toBe(false);
  });

  it("returns false for unknown type", () => {
    expect(Config.validateApiKey("anykey", "unknown")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(Config.validateApiKey("", "finnhub")).toBe(false);
  });
});

describe("getConfig singleton", () => {
  it("returns same instance on multiple calls", () => {
    const a = getConfig(NO_ENV);
    const b = getConfig(NO_ENV);
    expect(a).toBe(b);
  });

  it("creates new instance after reset", () => {
    const a = getConfig(NO_ENV);
    resetConfig();
    const b = getConfig(NO_ENV);
    expect(a).not.toBe(b);
  });
});
