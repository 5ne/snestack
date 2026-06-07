import {
  FstackError,
  ConfigError,
  ValidationError,
  APIError,
  QuoteServiceError,
  EquityServiceError,
  EmailServiceError,
  DatabaseError,
} from "../../src/core/errors";

describe("Error hierarchy", () => {
  it("FstackError is an Error", () => {
    const e = new FstackError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(FstackError);
    expect(e.message).toBe("test");
    expect(e.name).toBe("FstackError");
  });

  it("ConfigError extends FstackError", () => {
    const e = new ConfigError("cfg");
    expect(e).toBeInstanceOf(FstackError);
    expect(e.name).toBe("ConfigError");
  });

  it("ValidationError extends FstackError", () => {
    const e = new ValidationError("val");
    expect(e).toBeInstanceOf(FstackError);
    expect(e.name).toBe("ValidationError");
  });

  it("APIError extends FstackError", () => {
    const e = new APIError("api");
    expect(e).toBeInstanceOf(FstackError);
    expect(e.name).toBe("APIError");
  });

  it("QuoteServiceError extends APIError", () => {
    const e = new QuoteServiceError("quote");
    expect(e).toBeInstanceOf(APIError);
    expect(e).toBeInstanceOf(FstackError);
  });

  it("EquityServiceError extends APIError", () => {
    const e = new EquityServiceError("equity");
    expect(e).toBeInstanceOf(APIError);
  });

  it("EmailServiceError extends FstackError", () => {
    const e = new EmailServiceError("email");
    expect(e).toBeInstanceOf(FstackError);
    expect(e.name).toBe("EmailServiceError");
  });

  it("DatabaseError extends FstackError", () => {
    const e = new DatabaseError("db");
    expect(e).toBeInstanceOf(FstackError);
    expect(e.name).toBe("DatabaseError");
  });
});
