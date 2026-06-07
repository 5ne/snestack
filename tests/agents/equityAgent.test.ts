import { EquityAgent } from "../../src/agents/equityAgent";
import type { MorningstarData } from "../../src/tools/morningstarParser";

describe("EquityAgent.detectRedFlags", () => {
  it("returns empty array for clean fundamentals", () => {
    const data: MorningstarData = {
      pe_ratio: 20,
      debt_to_equity: 0.5,
      fcf: 1e9,
      fcf_yield: 0.05,
      earnings_growth: 0.15,
      revenue_growth: 0.10,
    };
    expect(EquityAgent.detectRedFlags(data)).toHaveLength(0);
  });

  it("flags high P/E ratio", () => {
    const flags = EquityAgent.detectRedFlags({ pe_ratio: 50 });
    expect(flags.some((f) => f.includes("P/E"))).toBe(true);
  });

  it("flags high debt", () => {
    const flags = EquityAgent.detectRedFlags({ debt_to_equity: 2.0 });
    expect(flags.some((f) => f.includes("debt"))).toBe(true);
  });

  it("flags negative FCF", () => {
    const flags = EquityAgent.detectRedFlags({ fcf: -1e8 });
    expect(flags.some((f) => f.includes("Negative free cash flow"))).toBe(true);
  });

  it("flags weak FCF yield", () => {
    const flags = EquityAgent.detectRedFlags({ fcf_yield: 0.005 });
    expect(flags.some((f) => f.includes("FCF yield"))).toBe(true);
  });

  it("flags declining earnings", () => {
    const flags = EquityAgent.detectRedFlags({ earnings_growth: -0.1 });
    expect(flags.some((f) => f.includes("Declining earnings"))).toBe(true);
  });

  it("flags declining revenue", () => {
    const flags = EquityAgent.detectRedFlags({ revenue_growth: -0.05 });
    expect(flags.some((f) => f.includes("Declining revenue"))).toBe(true);
  });

  it("flags high valuation with slow growth", () => {
    const flags = EquityAgent.detectRedFlags({ pe_ratio: 35, earnings_growth: 0.02 });
    expect(flags.some((f) => f.includes("High valuation"))).toBe(true);
  });

  it("flags high debt with weak cash", () => {
    const flags = EquityAgent.detectRedFlags({ debt_to_equity: 1.2, fcf_yield: 0.01 });
    expect(flags.some((f) => f.includes("High debt with weak cash"))).toBe(true);
  });

  it("detects multiple flags simultaneously", () => {
    const flags = EquityAgent.detectRedFlags({ pe_ratio: 55, debt_to_equity: 2.5, fcf: -5e8 });
    expect(flags.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores undefined values gracefully", () => {
    expect(() => EquityAgent.detectRedFlags({})).not.toThrow();
    expect(EquityAgent.detectRedFlags({})).toHaveLength(0);
  });
});

describe("EquityAgent instantiation", () => {
  it("creates with default reports dir", () => {
    const agent = new EquityAgent();
    expect(agent.name).toBe("EquityAgent");
  });

  it("creates with custom reports dir", () => {
    const agent = new EquityAgent("/tmp/reports");
    expect(agent).toBeDefined();
  });
});

describe("EquityAgent.analyze (no PDF)", () => {
  it("returns null when no Morningstar report exists", async () => {
    const agent = new EquityAgent("/nonexistent/path");
    const result = await agent.safeAnalyze("FAKE");
    expect(result).toBeNull();
  });
});
