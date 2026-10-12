import * as path from "path";
import { financialRunExpectations, financialRunRoots } from "../../../src/domains/financial/runExpectations";

describe("financialRunExpectations / financialRunRoots", () => {
  const brainRoot = "/fake/brain";

  it("registers one expectation per known financial automation, rooted under the brain root", () => {
    const expectations = financialRunExpectations(brainRoot);
    expect(expectations.map((e) => e.name)).toEqual([
      "financial",
      "financial-daily-refresh",
      "financial-intraday",
      "financial-swing-check",
    ]);
    for (const e of expectations) {
      expect(e.runsRoot.startsWith(brainRoot)).toBe(true);
    }
  });

  it("marks the multi-run-a-day automations with minRunsPerDay", () => {
    const expectations = financialRunExpectations(brainRoot);
    const byName = Object.fromEntries(expectations.map((e) => [e.name, e]));
    expect(byName["financial"].minRunsPerDay).toBeUndefined();
    expect(byName["financial-daily-refresh"].minRunsPerDay).toBeUndefined();
    expect(byName["financial-intraday"].minRunsPerDay).toBe(3);
    expect(byName["financial-swing-check"].minRunsPerDay).toBe(3);
  });

  it("financialRunRoots returns exactly each expectation's runsRoot, in the same order", () => {
    const expectations = financialRunExpectations(brainRoot);
    expect(financialRunRoots(brainRoot)).toEqual(expectations.map((e) => e.runsRoot));
    expect(financialRunRoots(brainRoot)).toContain(path.join(brainRoot, "financial", "signals"));
  });
});
