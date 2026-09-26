import { BaseAgent, ThrottledAPIAgent, retryAsync, sleep } from "../../../../src/domains/financial/agents/base";
import { APIError } from "../../../../src/core/errors";

// Concrete implementations for testing
class EchoAgent extends BaseAgent<string> {
  private results: Array<string | Error>;
  private callCount = 0;

  constructor(results: Array<string | Error>) {
    super("EchoAgent");
    this.results = results;
  }

  async analyze(ticker: string): Promise<string | null> {
    const result = this.results[this.callCount++];
    if (result instanceof Error) throw result;
    return result ?? null;
  }
}

class TestThrottledAgent extends ThrottledAPIAgent<string> {
  constructor(maxPerMinute = 60) {
    super("TestThrottled", maxPerMinute, 0.8);
  }

  async analyze(_ticker: string): Promise<string | null> {
    await this.checkRateLimit();
    return "ok";
  }
}

describe("BaseAgent", () => {
  describe("safeAnalyze", () => {
    it("returns result on success", async () => {
      const agent = new EchoAgent(["buy"]);
      const result = await agent.safeAnalyze("NVDA");
      expect(result).toBe("buy");
    });

    it("returns null on thrown error", async () => {
      const agent = new EchoAgent([new Error("network failure")]);
      const result = await agent.safeAnalyze("NVDA");
      expect(result).toBeNull();
    });

    it("returns null when analyze returns null", async () => {
      const agent = new EchoAgent([null as unknown as string]);
      const result = await agent.safeAnalyze("NVDA");
      expect(result).toBeNull();
    });
  });
});

describe("retryAsync", () => {
  it("succeeds on first attempt", async () => {
    let calls = 0;
    const result = await retryAsync(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on APIError and succeeds", async () => {
    let calls = 0;
    const result = await retryAsync(
      async () => {
        calls++;
        if (calls < 3) throw new APIError("temporary");
        return "success";
      },
      { maxAttempts: 3, initialDelay: 1 }
    );
    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("throws after max attempts exhausted", async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw new APIError("always fails");
        },
        { maxAttempts: 3, initialDelay: 1 }
      )
    ).rejects.toThrow(APIError);
    expect(calls).toBe(3);
  });

  it("does not retry on non-APIError", async () => {
    let calls = 0;
    await expect(
      retryAsync(async () => {
        calls++;
        throw new Error("non-api error");
      })
    ).rejects.toThrow("non-api error");
    expect(calls).toBe(1);
  });
});

describe("sleep", () => {
  it("resolves after delay", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

describe("ThrottledAPIAgent", () => {
  it("executes without throttling under limit", async () => {
    const agent = new TestThrottledAgent(60);
    const result = await agent.analyze("NVDA");
    expect(result).toBe("ok");
  });
});
