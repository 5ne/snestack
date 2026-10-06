import { dateRangeForYear, QUERY_TEMPLATES } from "../../../../src/domains/travel/tools/gmailClient";

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
