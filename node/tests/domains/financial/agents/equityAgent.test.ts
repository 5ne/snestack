import { EquityAgent } from "../../../../src/domains/financial/agents/equityAgent";
import type { MorningstarData } from "../../../../src/domains/financial/tools/morningstarParser";
import type { FundamentalsProvider } from "../../../../src/domains/financial/providers/types";
import type { Db } from "../../../../src/core/db";

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

describe("EquityAgent.analyze persists to db", () => {
  function makeProvider(data: MorningstarData): FundamentalsProvider {
    return { getFundamentals: jest.fn().mockResolvedValue(data) };
  }

  function makeDb(): Db {
    return { addFundamentals: jest.fn() } as unknown as Db;
  }

  it("calls db.addFundamentals with source 'morningstar' on a successful parse", async () => {
    const provider = makeProvider({ pe_ratio: 28.4, debt_to_equity: 0.6, fcf: 5e9 });
    const db = makeDb();
    const agent = new EquityAgent(undefined, provider, db);

    await agent.analyze("NVDA");

    expect(db.addFundamentals).toHaveBeenCalledTimes(1);
    const row = (db.addFundamentals as jest.Mock).mock.calls[0][0];
    expect(row.ticker).toBe("NVDA");
    expect(row.source).toBe("morningstar");
    expect(row.pe_ratio).toBe(28.4);
    expect(row.debt_to_equity).toBe(0.6);
    expect(row.fcf).toBe(5e9);
    expect(typeof row.red_flags).toBe("string"); // JSON-stringified array
  });

  it("does not call db.addFundamentals when no db is provided", async () => {
    const provider = makeProvider({ pe_ratio: 28.4 });
    const agent = new EquityAgent(undefined, provider);
    await expect(agent.analyze("NVDA")).resolves.not.toBeNull();
  });

  it("does not call db.addFundamentals when the provider returns null", async () => {
    const provider: FundamentalsProvider = { getFundamentals: jest.fn().mockResolvedValue(null) };
    const db = makeDb();
    const agent = new EquityAgent(undefined, provider, db);

    const result = await agent.analyze("NVDA");

    expect(result).toBeNull();
    expect(db.addFundamentals).not.toHaveBeenCalled();
  });
});
