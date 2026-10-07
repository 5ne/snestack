import { deriveFcf } from "../../../../src/domains/financial/providers/finnhubQuoteProvider";

describe("deriveFcf", () => {
  it("derives yield and sign from price-to-FCF when raw FCF is absent (free tier)", () => {
    const r = deriveFcf({ pfcfShareTTM: 35.56 }, { annual: { fcfMargin: [{ period: "2025-09-27", v: 0.2373 }] } });
    expect(r.fcfYield).toBeCloseTo(1 / 35.56, 6);
    expect(r.fcfPositive).toBe(true);
    expect(r.fcfMargin).toBe(0.2373);
  });

  it("falls back to the annual P/FCF when TTM is missing", () => {
    expect(deriveFcf({ pfcfShareAnnual: 8.8673 }).fcfYield).toBeCloseTo(1 / 8.8673, 6);
  });

  it("prefers raw FCF / market cap when Finnhub supplies it", () => {
    const r = deriveFcf({ freeCashFlowTTM: 100, marketCapitalization: 2000, pfcfShareTTM: 5 });
    expect(r.fcfYield).toBeCloseTo(0.05, 6);
  });

  it("keeps the sign for negative FCF", () => {
    const r = deriveFcf({ pfcfShareTTM: -40 });
    expect(r.fcfYield).toBeLessThan(0);
    expect(r.fcfPositive).toBe(false);
  });

  it("returns nulls rather than guessing when nothing usable is present", () => {
    expect(deriveFcf({})).toEqual({ fcfYield: null, fcfPositive: null, fcfMargin: null });
    expect(deriveFcf({ pfcfShareTTM: 0 }).fcfYield).toBeNull();
  });
});
