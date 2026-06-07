import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { ConfigError, ValidationError } from "./errors";

export class Config {
  // Env-var key constants
  static readonly FINNHUB_API_KEY = "FSTACK_FINNHUB_API_KEY";
  static readonly CLAUDE_API_KEY = "FSTACK_CLAUDE_API_KEY";
  static readonly GMAIL_ADDRESS = "FSTACK_GMAIL_ADDRESS";
  static readonly GMAIL_APP_PASSWORD = "FSTACK_GMAIL_APP_PASSWORD";
  static readonly NOTIFICATION_EMAIL = "FSTACK_NOTIFICATION_EMAIL";
  static readonly TWILIO_ACCOUNT_SID = "FSTACK_TWILIO_ACCOUNT_SID";
  static readonly TWILIO_AUTH_TOKEN = "FSTACK_TWILIO_AUTH_TOKEN";
  static readonly SMS_PHONE = "FSTACK_SMS_PHONE";
  static readonly DATABASE_PATH = "FSTACK_DATABASE_PATH";
  static readonly DEFAULT_DB_PATH = "../fstack.db";

  constructor(envFile?: string) {
    const file = envFile ?? path.join(process.cwd(), ".env");
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
    }
  }

  static get(key: string, defaultVal?: string): string | undefined {
    return process.env[key] ?? defaultVal;
  }

  static require(key: string): string {
    const val = process.env[key];
    if (!val) throw new ConfigError(`Required configuration missing: ${key}`);
    return val;
  }

  getDatabasePath(): string {
    return Config.get(Config.DATABASE_PATH) ?? Config.DEFAULT_DB_PATH;
  }

  getFinnhubApiKey(): string {
    const key = Config.require(Config.FINNHUB_API_KEY);
    if (key.length < 10) throw new ValidationError("Invalid Finnhub API key format");
    return key;
  }

  getClaudeApiKey(): string {
    const key = Config.require(Config.CLAUDE_API_KEY);
    if (!key.startsWith("sk-")) {
      throw new ValidationError("Invalid Claude API key (must start with sk-)");
    }
    return key;
  }

  getGmailAddress(): string {
    return Config.require(Config.GMAIL_ADDRESS);
  }

  getGmailAppPassword(): string {
    return Config.require(Config.GMAIL_APP_PASSWORD);
  }

  getNotificationEmail(): string {
    return Config.require(Config.NOTIFICATION_EMAIL);
  }

  getTwilioCredentials(): [string | undefined, string | undefined] {
    const sid = Config.get(Config.TWILIO_ACCOUNT_SID);
    const token = Config.get(Config.TWILIO_AUTH_TOKEN);
    if ((sid && !token) || (!sid && token)) {
      throw new ConfigError(
        "Both Twilio account SID and auth token must be provided"
      );
    }
    return [sid, token];
  }

  getSmsPhone(): string | undefined {
    return Config.get(Config.SMS_PHONE);
  }

  static validateApiKey(key: string, keyType: string): boolean {
    if (!key || typeof key !== "string") return false;
    const validations: Record<string, (k: string) => boolean> = {
      finnhub: (k) => k.length > 10,
      claude: (k) => k.startsWith("sk-") && k.length > 20,
      gmail: (k) => k.includes("@") || k.length > 20,
      twilio_sid: (k) => k.startsWith("AC") && k.length === 34,
      twilio_token: (k) => k.length > 30,
    };
    return validations[keyType]?.(key) ?? false;
  }
}

// Singleton
let _config: Config | null = null;

export function getConfig(envFile?: string): Config {
  if (!_config) _config = new Config(envFile);
  return _config;
}

/** Reset singleton (for tests). */
export function resetConfig(): void {
  _config = null;
}
