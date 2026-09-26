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
