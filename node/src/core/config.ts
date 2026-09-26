import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as dotenv from "dotenv";
import { ConfigError, ValidationError } from "./errors";

export class Config {
  // Env-var key constants
  static readonly FINNHUB_API_KEY = "SNESTACK_FINNHUB_API_KEY";
  static readonly CLAUDE_API_KEY = "SNESTACK_CLAUDE_API_KEY";
  static readonly GMAIL_ADDRESS = "SNESTACK_GMAIL_ADDRESS";
  static readonly GMAIL_APP_PASSWORD = "SNESTACK_GMAIL_APP_PASSWORD";
  static readonly NOTIFICATION_EMAIL = "SNESTACK_NOTIFICATION_EMAIL";
  static readonly TWILIO_ACCOUNT_SID = "SNESTACK_TWILIO_ACCOUNT_SID";
  static readonly TWILIO_AUTH_TOKEN = "SNESTACK_TWILIO_AUTH_TOKEN";
  static readonly SMS_PHONE = "SNESTACK_SMS_PHONE";
  static readonly DATABASE_PATH = "SNESTACK_DATABASE_PATH";
  // Shared db lives in the Google Drive-synced folder, outside the repo — see README.
  static readonly DEFAULT_DB_PATH = path.join(
    os.homedir(),
    "Documents",
    "personal-brain",
    "financial",
    "snestack.db"
  );
  static readonly BRAIN_ROOT = "SNESTACK_BRAIN_ROOT";
  // Root of the shared Google Drive-synced brain folder — each domain's brain
  // lives under <root>/<domain>/brain/ (e.g. <root>/financial/brain/).
  static readonly DEFAULT_BRAIN_ROOT = path.join(os.homedir(), "Documents", "personal-brain");

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

  /** Set a configuration value in the current process environment. */
  static set(key: string, value: string): void {
    process.env[key] = value;
  }

  getDatabasePath(): string {
    return Config.get(Config.DATABASE_PATH) ?? Config.DEFAULT_DB_PATH;
  }

  getBrainRoot(): string {
    return Config.get(Config.BRAIN_ROOT) ?? Config.DEFAULT_BRAIN_ROOT;
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

  /**
   * Write current SNESTACK_* environment variables to a .env file, preserving
   * any existing non-SNESTACK lines and merging with existing SNESTACK_* values.
   * Mirrors the Python implementation's save_to_file.
   */
  saveToFile(envFile?: string): string {
    const target = envFile ?? path.join(process.cwd(), ".env");
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing: Record<string, string> = {};
    if (fs.existsSync(target)) {
      const contents = fs.readFileSync(target, "utf8");
      for (const rawLine of contents.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        const idx = line.indexOf("=");
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        existing[key] = val;
      }
    }

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("SNESTACK_") && value !== undefined) {
        existing[key] = value;
      }
    }

    const lines = ["# snestack configuration", "# Auto-generated - edit with care", ""];
    for (const key of Object.keys(existing).sort()) {
      const value = existing[key];
      if (value.includes(" ") || value.includes("=")) {
        lines.push(`${key}="${value}"`);
      } else {
        lines.push(`${key}=${value}`);
      }
    }
    fs.writeFileSync(target, lines.join("\n") + "\n");
    return target;
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
