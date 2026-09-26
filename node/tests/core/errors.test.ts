import {
  SnestackError,
  ConfigError,
  ValidationError,
  APIError,
  QuoteServiceError,
  EquityServiceError,
  EmailServiceError,
  DatabaseError,
} from "../../src/core/errors";

describe("Error hierarchy", () => {
  it("SnestackError is an Error", () => {
    const e = new SnestackError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SnestackError);
    expect(e.message).toBe("test");
    expect(e.name).toBe("SnestackError");
  });

  it("ConfigError extends SnestackError", () => {
    const e = new ConfigError("cfg");
    expect(e).toBeInstanceOf(SnestackError);
    expect(e.name).toBe("ConfigError");
  });

  it("ValidationError extends SnestackError", () => {
    const e = new ValidationError("val");
    expect(e).toBeInstanceOf(SnestackError);
    expect(e.name).toBe("ValidationError");
  });

  it("APIError extends SnestackError", () => {
    const e = new APIError("api");
    expect(e).toBeInstanceOf(SnestackError);
    expect(e.name).toBe("APIError");
  });

  it("QuoteServiceError extends APIError", () => {
    const e = new QuoteServiceError("quote");
    expect(e).toBeInstanceOf(APIError);
    expect(e).toBeInstanceOf(SnestackError);
  });

  it("EquityServiceError extends APIError", () => {
    const e = new EquityServiceError("equity");
    expect(e).toBeInstanceOf(APIError);
  });

  it("EmailServiceError extends SnestackError", () => {
    const e = new EmailServiceError("email");
    expect(e).toBeInstanceOf(SnestackError);
    expect(e.name).toBe("EmailServiceError");
  });

  it("DatabaseError extends SnestackError", () => {
    const e = new DatabaseError("db");
    expect(e).toBeInstanceOf(SnestackError);
    expect(e.name).toBe("DatabaseError");
  });
});
