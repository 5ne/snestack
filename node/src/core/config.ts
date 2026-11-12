import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as dotenv from "dotenv";
import { ConfigError, ValidationError } from "./errors";

/** Cost tiers used by skills (frontmatter `model:`) and code; each maps to a concrete model via Config.getModel(). */
export type ModelTier = "cheap" | "normal" | "expensive";
export const MODEL_TIERS: readonly ModelTier[] = ["cheap", "normal", "expensive"];

/** Canonical backend IDs supported by runPrompt ("claude-api" in config normalizes to "api"). */
export type ExecutorBackend = "agy-cli" | "claude-cli" | "api";

function normalizeExecutorBackend(token: string): ExecutorBackend | null {
  if (token === "agy-cli") return "agy-cli";
  if (token === "claude-cli") return "claude-cli";
  if (token === "api" || token === "claude-api") return "api";
  return null;
}

/**
 * Parse SNESTACK_EXECUTOR (and optional legacy SNESTACK_EXECUTOR_FALLBACK) into an
 * ordered list of backends to attempt before failing gracefully.
 *
 * Chain syntax examples:
 *   "agy-cli>fail"                       -> ["agy-cli"]
 *   "agy-cli>claude-cli>fail"            -> ["agy-cli", "claude-cli"]
 *   "agy-cli>claude-cli>claude-api>fail" -> ["agy-cli", "claude-cli", "api"]
 *   "claude-cli>claude-api>fail"         -> ["claude-cli", "api"]
 */
export function parseExecutorChain(rawExecutor?: string, rawFallback?: string): ExecutorBackend[] {
  const raw = (rawExecutor ?? "api").trim().toLowerCase();
  if (raw === "") return ["api"];

  if (raw.includes(">")) {
    const segments = raw.split(">").map((s) => s.trim());
    if (segments.some((s) => s.length === 0)) {
      throw new ValidationError(`Invalid ${Config.EXECUTOR} "${rawExecutor}": empty step in chain`);
    }
    const chain: ExecutorBackend[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === "fail") {
        if (i === 0 || i !== segments.length - 1) {
          throw new ValidationError(
            `Invalid ${Config.EXECUTOR} "${rawExecutor}": "fail" may only appear at the end of a chain (e.g. "agy-cli>fail")`
          );
        }
        break;
      }
      const b = normalizeExecutorBackend(seg);
      if (!b) {
        throw new ValidationError(
          `Invalid ${Config.EXECUTOR} step "${seg}" in "${rawExecutor}" (expected agy-cli, claude-cli, claude-api, api, or trailing fail)`
        );
      }
      if (chain.includes(b)) {
        throw new ValidationError(`Invalid ${Config.EXECUTOR} "${rawExecutor}": duplicate backend "${seg}" in chain`);
      }
      chain.push(b);
    }
    return chain;
  }

  const primary = normalizeExecutorBackend(raw);
  if (!primary) {
    throw new ValidationError(
      `Invalid ${Config.EXECUTOR} "${rawExecutor}" (expected agy-cli, claude-cli, claude-api, api, or a ">"-chain like "agy-cli>fail")`
    );
  }
  if (primary === "api") return ["api"];

  // Legacy SNESTACK_EXECUTOR_FALLBACK handling when SNESTACK_EXECUTOR is a single backend name:
  // claude-cli historically defaulted to "api" fallback; agy-cli defaults to no fallback ("fail") so it never
  // silently jumps from a Google AI Pro/Ultra subscription to a paid API unless explicitly configured.
  const fbDefault = primary === "claude-cli" ? "api" : "none";
  const fb = (rawFallback ?? fbDefault).trim().toLowerCase();
  if (fb === "" || fb === "none" || fb === "fail") return [primary];

  const tail = parseExecutorChain(fb.includes(">") ? fb : `${fb}>fail`);
  const chain: ExecutorBackend[] = [primary];
  for (const b of tail) {
    if (!chain.includes(b)) chain.push(b);
  }
  return chain;
}

export class Config {
  // Env-var key constants
  static readonly FINNHUB_API_KEY = "SNESTACK_FINNHUB_API_KEY";
  // Optional — historical daily closes for RSI/MA, since Finnhub's free tier
  // blocks /stock/candle. Falls back to Finnhub-only (no RSI/MA) if unset.
  static readonly TWELVEDATA_API_KEY = "SNESTACK_TWELVEDATA_API_KEY";
  static readonly CLAUDE_API_KEY = "SNESTACK_CLAUDE_API_KEY";
  /**
   * Ordered backend chain for runPrompt, e.g. "agy-cli>fail" or "agy-cli>claude-cli>claude-api>fail"
   * (also accepts single values "api" | "claude-api" | "claude-cli" | "agy-cli").
   */
  static readonly EXECUTOR = "SNESTACK_EXECUTOR";
  /** Legacy fallback setting when SNESTACK_EXECUTOR is a single backend without ">". Prefer ">"-chains in SNESTACK_EXECUTOR. */
  static readonly EXECUTOR_FALLBACK = "SNESTACK_EXECUTOR_FALLBACK";
  static readonly CLI_TIMEOUT_MS = "SNESTACK_CLI_TIMEOUT_MS";
  static readonly AGY_MODEL_ENV: Record<ModelTier, string> = {
    cheap: "SNESTACK_AGY_MODEL_CHEAP",
    normal: "SNESTACK_AGY_MODEL_NORMAL",
    expensive: "SNESTACK_AGY_MODEL_EXPENSIVE",
  };
  static readonly CLI_MODEL_ENV: Record<ModelTier, string> = {
    cheap: "SNESTACK_CLI_MODEL_CHEAP",
    normal: "SNESTACK_CLI_MODEL_NORMAL",
    expensive: "SNESTACK_CLI_MODEL_EXPENSIVE",
  };
  static readonly MODEL_ENV: Record<ModelTier, string> = {
    cheap: "SNESTACK_MODEL_CHEAP",
    normal: "SNESTACK_MODEL_NORMAL",
    expensive: "SNESTACK_MODEL_EXPENSIVE",
  };
  static readonly DEFAULT_MODELS: Record<ModelTier, string> = {
    cheap: "claude-haiku-4-5-20251001",
    normal: "claude-sonnet-5-5",
    expensive: "claude-opus-5-5",
  };
  static readonly GMAIL_ADDRESS = "SNESTACK_GMAIL_ADDRESS";
  static readonly GMAIL_APP_PASSWORD = "SNESTACK_GMAIL_APP_PASSWORD";
  static readonly NOTIFICATION_EMAIL = "SNESTACK_NOTIFICATION_EMAIL";
  static readonly TWILIO_ACCOUNT_SID = "SNESTACK_TWILIO_ACCOUNT_SID";
  static readonly TWILIO_AUTH_TOKEN = "SNESTACK_TWILIO_AUTH_TOKEN";
  static readonly SMS_PHONE = "SNESTACK_SMS_PHONE";
  static readonly BRAIN_ROOT = "SNESTACK_BRAIN_ROOT";
  static readonly DATABASE_URL = "SNESTACK_DATABASE_URL";
  // Root of the shared Google Drive-synced folder — the one directory setting
  // for all of a domain's shared data. Each domain's brain lives under
  // <root>/<domain>/brain/ (e.g. <root>/financial/brain/), and the financial
  // reports live at <root>/financial/reports/ — derived from
  // this single root rather than configured separately. (The financial db is Postgres, see SNESTACK_DATABASE_URL.)
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

  /**
   * Postgres (Supabase) connection string for the financial db. Lives only in
   * the gitignored node/.env — never in the Drive-synced brain or the repo.
   */
  getDatabaseUrl(): string {
    return Config.require(Config.DATABASE_URL);
  }

  getBrainRoot(): string {
    return Config.get(Config.BRAIN_ROOT) ?? Config.DEFAULT_BRAIN_ROOT;
  }

  getFinnhubApiKey(): string {
    const key = Config.require(Config.FINNHUB_API_KEY);
    if (key.length < 10) throw new ValidationError("Invalid Finnhub API key format");
    return key;
  }

  /** Optional — undefined means "no Twelve Data key configured, fall back to Finnhub-only". */
  getTwelveDataApiKey(): string | undefined {
    return Config.get(Config.TWELVEDATA_API_KEY);
  }

  getClaudeApiKey(): string {
    const key = Config.require(Config.CLAUDE_API_KEY);
    if (!key.startsWith("sk-")) {
      throw new ValidationError("Invalid Claude API key (must start with sk-)");
    }
    return key;
  }

  /** Ordered list of backends runPrompt tries before failing (e.g. ["agy-cli"] for "agy-cli>fail"). */
  getExecutorChain(): ExecutorBackend[] {
    return parseExecutorChain(Config.get(Config.EXECUTOR), Config.get(Config.EXECUTOR_FALLBACK));
  }

  /** Human-readable representation of the active chain, always ending in ">fail". */
  getExecutorChainDisplay(): string {
    return [...this.getExecutorChain().map((b) => (b === "api" ? "claude-api" : b)), "fail"].join(">");
  }

  /** Primary (first) backend in the configured executor chain. */
  getExecutorBackend(): ExecutorBackend {
    return this.getExecutorChain()[0];
  }

  /** Whether a metered API step appears as a fallback anywhere after the primary backend. */
  isApiFallbackEnabled(): boolean {
    return this.getExecutorChain().slice(1).includes("api");
  }

  /** The API key runPrompt needs: required when "api" ("claude-api") is primary; optional otherwise (validated only if fallback reaches "api"). */
  getExecutorApiKey(): string {
    if (this.getExecutorBackend() !== "api") {
      const key = Config.get(Config.CLAUDE_API_KEY);
      return key && key.startsWith("sk-") ? key : "";
    }
    return this.getClaudeApiKey();
  }

  /** Optional model id passed to `agy --model` for a tier; undefined means let `agy` use the Pro/Ultra session's default model. */
  getAgyModel(tier: ModelTier = "normal"): string | undefined {
    const v = Config.get(Config.AGY_MODEL_ENV[tier])?.trim();
    return v ? v : undefined;
  }

  /** Model id passed to `claude --model`; defaults to the same model as the tier's API model. */
  getCliModel(tier: ModelTier = "normal"): string {
    return Config.get(Config.CLI_MODEL_ENV[tier]) ?? this.getModel(tier);
  }

  /** Resolve a tier keyword ("cheap" | "normal" | "expensive") to a concrete model ID; each tier is overridable via env. */
  getModel(tier: ModelTier = "normal"): string {
    return Config.get(Config.MODEL_ENV[tier]) ?? Config.DEFAULT_MODELS[tier];
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
