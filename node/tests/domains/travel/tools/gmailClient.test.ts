import {
  dateRangeForYear,
  QUERY_TEMPLATES,
  mapWithConcurrency,
  withQuotaRetry,
  selectFullBodyCandidates,
  type EmailSummary,
} from "../../../../src/domains/travel/tools/gmailClient";

function summary(overrides: Partial<EmailSummary>): EmailSummary {
  return {
    messageId: "m1",
    threadId: "t1",
    date: "2024-01-01T00:00:00.000Z",
    from: "noreply@united.com",
    subject: "eTicket Itinerary and Receipt for Confirmation ABC123",
    snippet: "...",
    matchedQuery: "flights",
    ...overrides,
  };
}

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

describe("selectFullBodyCandidates", () => {
  it("picks evidence-bearing categories and skips noise categories like rideshare/cancellations", () => {
    const summaries = [
      summary({ messageId: "a", threadId: "ta", matchedQuery: "flights" }),
      summary({ messageId: "b", threadId: "tb", matchedQuery: "rideshare" }),
      summary({ messageId: "c", threadId: "tc", matchedQuery: "cancellations" }),
    ];
    const candidates = selectFullBodyCandidates(summaries);
    expect(candidates.map((c) => c.messageId)).toEqual(["a"]);
  });

  it("excludes marketing/loyalty/survey-shaped subjects even in an evidence-bearing category", () => {
    const summaries = [
      summary({ messageId: "a", threadId: "ta", subject: "Your monthly AAdvantage summary" }),
      summary({ messageId: "b", threadId: "tb", subject: "Tell us how we did" }),
      summary({ messageId: "c", threadId: "tc", subject: "eTicket Itinerary and Receipt for Confirmation XYZ" }),
    ];
    const candidates = selectFullBodyCandidates(summaries);
    expect(candidates.map((c) => c.messageId)).toEqual(["c"]);
  });

  it("keeps only one representative per thread", () => {
    const summaries = [
      summary({ messageId: "a", threadId: "same-thread" }),
      summary({ messageId: "b", threadId: "same-thread" }),
    ];
    const candidates = selectFullBodyCandidates(summaries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].messageId).toBe("a");
  });

  it("caps the total number of candidates", () => {
    const summaries = Array.from({ length: 100 }, (_, i) =>
      summary({ messageId: `m${i}`, threadId: `t${i}` })
    );
    const candidates = selectFullBodyCandidates(summaries);
    expect(candidates.length).toBeLessThanOrEqual(60);
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
