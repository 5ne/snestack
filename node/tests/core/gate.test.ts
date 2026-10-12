import { evaluateGate, type GateFacts } from "../../src/core/gate";

const now = new Date("2026-10-08T15:30:00Z");
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  now,
  rsi: 50,
  price: 100,
  lastRunAt: new Date("2026-10-07T15:30:00Z"),
  lastRunPrice: 100,
  lastRunRsi: 50,
  inputsUpdatedAfterLastRun: false,
  ...over,
});

describe("evaluateGate", () => {
  it("runs when there is no gate", () => {
    expect(evaluateGate(undefined, facts()).run).toBe(true);
  });

  describe("RSI-only gate (swing)", () => {
    const cfg = { rsiBelow: 30, rsiAbove: 70 };
    it("skips a neutral RSI and says why", () => {
      const d = evaluateGate(cfg, facts({ rsi: 49.6 }));
      expect(d.run).toBe(false);
      expect(d.reasons[0]).toContain("49.6");
    });
    it("runs when oversold or overbought", () => {
      expect(evaluateGate(cfg, facts({ rsi: 27.3 })).run).toBe(true);
      expect(evaluateGate(cfg, facts({ rsi: 73.9 })).run).toBe(true);
    });
    it("treats the thresholds as exclusive", () => {
      expect(evaluateGate(cfg, facts({ rsi: 30 })).run).toBe(false);
      expect(evaluateGate(cfg, facts({ rsi: 70 })).run).toBe(false);
    });
    it("does not force a run just because there is no previous run", () => {
      expect(evaluateGate(cfg, facts({ lastRunAt: null, rsi: 50 })).run).toBe(false);
    });
    it("fails open when RSI is unavailable", () => {
      const d = evaluateGate(cfg, facts({ rsi: null }));
      expect(d.run).toBe(true);
      expect(d.reasons[0]).toContain("no RSI");
    });
  });

  describe("minRsiMoveToRerun (swing re-run cooldown)", () => {
    const cfg = { rsiBelow: 30, rsiAbove: 70, minRsiMoveToRerun: 5 };
    it("suppresses a repeat trigger when RSI barely moved since the last run", () => {
      const d = evaluateGate(cfg, facts({ rsi: 27.3, lastRunRsi: 27.0 }));
      expect(d.run).toBe(false);
      expect(d.reasons[0]).toContain("only moved");
    });
    it("still runs once RSI has moved enough since the last run", () => {
      expect(evaluateGate(cfg, facts({ rsi: 20, lastRunRsi: 27.0 })).run).toBe(true);
    });
    it("runs on a fresh crossing with no known lastRunRsi (fails open)", () => {
      expect(evaluateGate(cfg, facts({ rsi: 27.3, lastRunRsi: null })).run).toBe(true);
    });
    it("is irrelevant to a neutral RSI (no threshold crossed at all)", () => {
      const d = evaluateGate(cfg, facts({ rsi: 50, lastRunRsi: 50.5 }));
      expect(d.run).toBe(false);
      expect(d.reasons[0]).not.toContain("only moved");
    });
  });

  describe("minRsiMoveToRerun does not affect other triggers (long-term)", () => {
    const cfg = { rsiBelow: 40, rsiAbove: 70, priceMovePct: 5, minRsiMoveToRerun: 5 };
    it("still runs on a price move even when RSI is cooldown-suppressed", () => {
      const d = evaluateGate(cfg, facts({ rsi: 71, lastRunRsi: 70.5, price: 120 }));
      expect(d.run).toBe(true);
      expect(d.reasons.some((r) => r.includes("price moved"))).toBe(true);
      expect(d.reasons.some((r) => r.includes("RSI"))).toBe(false);
    });
  });

  describe("stateful gate (long-term)", () => {
    const cfg = { rsiBelow: 40, rsiAbove: 70, priceMovePct: 5, maxAgeDays: 7, inputsUpdated: true };
    it("skips when nothing has changed", () => {
      const d = evaluateGate(cfg, facts({ rsi: 52, price: 101 }));
      expect(d.run).toBe(false);
      expect(d.reasons[0]).toContain("no trigger");
    });
    it("runs when never run before", () => {
      expect(evaluateGate(cfg, facts({ lastRunAt: null })).reasons).toContain("no previous run on record");
    });
    it("runs when RSI is in add territory", () => {
      expect(evaluateGate(cfg, facts({ rsi: 35 })).run).toBe(true);
    });
    it("runs on a big price move since the last run, in either direction", () => {
      expect(evaluateGate(cfg, facts({ price: 106 })).run).toBe(true);
      expect(evaluateGate(cfg, facts({ price: 94 })).run).toBe(true);
      expect(evaluateGate(cfg, facts({ price: 104 })).run).toBe(false);
    });
    it("runs once the last run is old enough", () => {
      expect(evaluateGate(cfg, facts({ lastRunAt: new Date("2026-10-01T15:30:00Z") })).run).toBe(true);
    });
    it("runs when inputs changed since the last run", () => {
      expect(evaluateGate(cfg, facts({ inputsUpdatedAfterLastRun: true })).run).toBe(true);
    });
    it("reports every trigger that fired", () => {
      const d = evaluateGate(cfg, facts({ rsi: 35, price: 120, inputsUpdatedAfterLastRun: true }));
      expect(d.reasons.length).toBe(3);
    });
  });
});
