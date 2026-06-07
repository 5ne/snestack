/** Custom error hierarchy for fstack. */

export class FstackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigError extends FstackError {}
export class ValidationError extends FstackError {}
export class APIError extends FstackError {}
export class QuoteServiceError extends APIError {}
export class EquityServiceError extends APIError {}
export class EmailServiceError extends FstackError {}
export class DatabaseError extends FstackError {}
