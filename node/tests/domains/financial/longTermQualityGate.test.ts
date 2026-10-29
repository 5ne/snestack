import * as path from "path";
import { loadSkillFile } from "../../../src/core/skillLoader";
import { evaluateGate, type GateConfig, type GateFacts } from "../../../src/core/gate";

// The real skill file's gate config, so a frontmatter edit that drops the rule fails here.
const gate = loadSkillFile(
  path.join(__dirname, "../../../src/domains/financial/skills/long-term-quality.md")
).frontmatter.gate as GateConfig;

const now = new Date("2026-10-28T21:30:00Z");
const DAY = 86_400_000;
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  now,
  rsi: 21.8,
  price: 100,
  lastRunAt: new Date(now.getTime() - 1 * DAY),
  lastRunPrice: 100,
  lastRunRsi: 22.0,
  inputsUpdatedAfterLastRun: false,
  ...over,
});

describe("long-term-quality gate", () => {
  it("declares minRsiMoveToRerun and keeps the weekly backstop", () => {
    expect(gate.minRsiMoveToRerun).toBe(5);
    expect(gate.maxAgeDays).toBe(7);
  });

  it("skips a name that stays oversold with nothing new (GOOG RSI 22.0 -> 21.8)", () => {
    const d = evaluateGate(gate, facts());
    expect(d.run).toBe(false);
    expect(d.reasons.join(" ")).toContain("still below 40");
  });

  it("runs when RSI has moved enough since the last run", () => {
    expect(evaluateGate(gate, facts({ rsi: 30, lastRunRsi: 22 })).run).toBe(true);
  });

  it("runs when a stuck-oversold name hits the weekly backstop", () => {
    expect(evaluateGate(gate, facts({ lastRunAt: new Date(now.getTime() - 7.5 * DAY) })).run).toBe(true);
  });

  it("still runs on a price move, new inputs, or a first run", () => {
    expect(evaluateGate(gate, facts({ price: 106 })).run).toBe(true);
    expect(evaluateGate(gate, facts({ inputsUpdatedAfterLastRun: true })).run).toBe(true);
    expect(evaluateGate(gate, facts({ lastRunAt: null, lastRunRsi: null })).run).toBe(true);
  });

  it("runs the first time a name crosses into oversold (no prior RSI to compare)", () => {
    expect(evaluateGate(gate, facts({ lastRunRsi: null })).run).toBe(true);
  });
});
