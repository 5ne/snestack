import { dateRangeForYear, QUERY_TEMPLATES, mapWithConcurrency, withQuotaRetry } from "../../../../src/domains/travel/tools/gmailClient";

describe("dateRangeForYear", () => {
  it("spans exactly one calendar year", () => {
    expect(dateRangeForYear(2024)).toEqual({ after: "2024/01/01", before: "2025/01/01" });
  });
});

describe("QUERY_TEMPLATES", () => {
  it("covers the main trip-evidence categories without overlapping names", () => {
    const names = QUERY_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(["flights", "hotels", "car-rentals", "dining", "rideshare"])
    );
  });

  it("every query is non-empty", () => {
    for (const { query } of QUERY_TEMPLATES) {
      expect(query.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("mapWithConcurrency", () => {
  it("runs every item and preserves input order in the output", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("never runs more than `concurrency` calls at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return i;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe("withQuotaRetry", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("returns the result on first success without retrying", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(withQuotaRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a quota-exceeded error and eventually succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("Quota exceeded for quota metric 'Total Query Cost'"))
      .mockResolvedValueOnce("ok");

    const promise = withQuotaRetry(fn);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up and rethrows after maxAttempts quota errors", async () => {
    const quotaError = new Error("Quota exceeded for quota metric 'Total Query Cost'");
    const fn = jest.fn().mockRejectedValue(quotaError);

    const promise = withQuotaRetry(fn, 3);
    const assertion = expect(promise).rejects.toBe(quotaError);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-quota error", async () => {
    const otherError = new Error("some other failure");
    const fn = jest.fn().mockRejectedValue(otherError);
    await expect(withQuotaRetry(fn)).rejects.toBe(otherError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
