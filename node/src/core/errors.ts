/** Custom error hierarchy for snestack. */

export class SnestackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigError extends SnestackError {}
export class ValidationError extends SnestackError {}
export class APIError extends SnestackError {}
export class QuoteServiceError extends APIError {}
export class EquityServiceError extends APIError {}
export class EmailServiceError extends SnestackError {}
export class DatabaseError extends SnestackError {}

/** A model-call backend failure. `code` lets run-check tell a usage limit or expired login from a generic error. */
export type ExecutorErrorCode = "usage_limit" | "login_expired" | "not_logged_in" | "misconfigured_auth" | "cli_missing" | "timeout" | "bad_output" | "cli_failed" | "api_credit_exhausted";
export class ExecutorError extends SnestackError {
  constructor(message: string, public readonly code: ExecutorErrorCode) {
    super(message);
  }
}
