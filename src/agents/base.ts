import { getLogger } from "../core/logger";
import { APIError } from "../core/errors";
import type winston from "winston";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  backoffMultiplier?: number;
  maxDelay?: number;
}

/** Sleep for ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * Only retries on APIError; other errors propagate immediately.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    backoffMultiplier = 2,
    maxDelay = 60000,
  } = opts;

  let delay = initialDelay;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof APIError) {
        lastError = e;
        if (attempt < maxAttempts) {
          await sleep(delay);
          delay = Math.min(delay * backoffMultiplier, maxDelay);
        }
      } else {
        throw e; // non-API errors: don't retry
      }
    }
  }
  throw lastError!;
}

/** Abstract base for all fstack agents. */
export abstract class BaseAgent<TResult> {
  protected readonly logger: winston.Logger;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    this.logger = getLogger(name);
  }

  abstract analyze(ticker: string, ...args: unknown[]): Promise<TResult | null>;

  /** Safe wrapper: catches all errors and returns null on failure. */
  async safeAnalyze(ticker: string, ...args: unknown[]): Promise<TResult | null> {
    const start = Date.now();
    this.logger.debug(`Starting analysis for ${ticker}`);
    try {
      const result = await this.analyze(ticker, ...args);
      this.logger.debug(`Completed ${ticker} in ${Date.now() - start}ms`);
      return result;
    } catch (e) {
      this.logger.error(`Failed analyzing ${ticker}: ${e}`);
      return null;
    }
  }
}

/** Base agent with per-minute rate limiting. */
export abstract class ThrottledAPIAgent<TResult> extends BaseAgent<TResult> {
  private callCount = 0;
  private lastReset = Date.now();
  private readonly maxCallsPerMinute: number;
  private readonly warnThreshold: number;

  constructor(
    name: string,
    maxCallsPerMinute = 60,
    warnThreshold = 0.8
  ) {
    super(name);
    this.maxCallsPerMinute = maxCallsPerMinute;
    this.warnThreshold = warnThreshold;
  }

  protected async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastReset) / 1000;

    if (elapsed >= 60) {
      this.callCount = 0;
      this.lastReset = now;
      return;
    }

    this.callCount++;
    const ratio = this.callCount / this.maxCallsPerMinute;

    if (ratio > this.warnThreshold) {
      this.logger.warn(
        `Rate limit approaching: ${this.callCount}/${this.maxCallsPerMinute} calls/min`
      );
    }

    if (this.callCount >= this.maxCallsPerMinute) {
      const sleepMs = (60 - elapsed) * 1000;
      this.logger.info(`Rate limit reached. Sleeping ${(sleepMs / 1000).toFixed(1)}s`);
      await sleep(sleepMs);
      this.callCount = 0;
      this.lastReset = Date.now();
    }
  }
}
