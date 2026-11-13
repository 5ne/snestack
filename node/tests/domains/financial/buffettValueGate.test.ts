import * as fs from "fs";
import * as path from "path";
import { loadSkillFile } from "../../../src/core/skillLoader";
import { evaluateGate, type GateConfig, type GateFacts } from "../../../src/core/gate";

const skillsDir = path.join(__dirname, "../../../src/domains/financial/skills");
const buffettSkill = loadSkillFile(path.join(skillsDir, "buffett-value.md"));
const longTermSkill = loadSkillFile(path.join(skillsDir, "long-term-quality.md"));

const gate = buffettSkill.frontmatter.gate as GateConfig;

const now = new Date("2026-10-28T21:30:00Z");
const DAY = 86_400_000;
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  now,
  rsi: 55,
  price: 100,
  lastRunAt: new Date(now.getTime() - 2 * DAY),
  lastRunPrice: 100,
  lastRunRsi: 54,
  inputsUpdatedAfterLastRun: false,
  ...over,
});

describe("buffett-value standalone third strategy", () => {
  it("keeps long-term-quality.md untouched as a separate strategy", () => {
    expect(longTermSkill.frontmatter.name).toBe("long-term-quality");
    expect(longTermSkill.frontmatter.references).toEqual(["quality-bar"]);
    expect(buffettSkill.frontmatter.name).toBe("buffett-value");
    expect(buffettSkill.frontmatter.references).toEqual(["quality-bar", "buffett-playbook"]);
  });

  it("uses a patient Omaha gate: 14-day backstop, 8% price move, fat-pitch rsiBelow 38, and NO rsiAbove sell trigger", () => {
    expect(gate.rsiBelow).toBe(38);
    expect(gate.rsiAbove).toBeUndefined();
    expect(gate.minRsiMoveToRerun).toBe(5);
    expect(gate.priceMovePct).toBe(8);
    expect(gate.maxAgeDays).toBe(14);
    expect(gate.inputsUpdated).toBe(true);

    // Overbought RSI (e.g. 76) on a quiet price move does NOT trigger buffett-value
    expect(evaluateGate(gate, facts({ rsi: 76, lastRunRsi: 68 })).run).toBe(false);

    // Fat-pitch pullback (RSI 32 from 54), 8%+ price move, updated Morningstar/brain file, or 14d age DO trigger
    expect(evaluateGate(gate, facts({ rsi: 32, lastRunRsi: 54 })).run).toBe(true);
    expect(evaluateGate(gate, facts({ price: 91 })).run).toBe(true);
    expect(evaluateGate(gate, facts({ inputsUpdatedAfterLastRun: true })).run).toBe(true);
    expect(evaluateGate(gate, facts({ lastRunAt: new Date(now.getTime() - 15 * DAY) })).run).toBe(true);
  });

  it("loads both quality-bar and buffett-playbook references and evaluates moat, owner earnings, debt, capital allocation, and margin of safety", () => {
    expect(buffettSkill.frontmatter.verdict).toBe(true);
    expect(buffettSkill.frontmatter.requires).toEqual(["quote", "fundamentals", "brain"]);

    for (const ref of buffettSkill.frontmatter.references ?? []) {
      const refPath = path.join(skillsDir, "references", `${ref}.md`);
      expect(fs.existsSync(refPath)).toBe(true);
    }

    const playbook = fs.readFileSync(path.join(skillsDir, "references", "buffett-playbook.md"), "utf8");
    expect(playbook).toContain("The Essays of Warren Buffett");
    expect(playbook).toContain("The Warren Buffett Way");
    expect(playbook).toContain("Owner Earnings");
    expect(playbook).toContain("Capital Allocation");
    expect(playbook).toContain("Margin of Safety");

    const qualityBar = fs.readFileSync(path.join(skillsDir, "references", "quality-bar.md"), "utf8");
    expect(qualityBar).toContain("## Long-term quality bar (long-term-quality.md)");
    expect(qualityBar).toContain("## Swing-trading eligibility (swing-trading-large-cap.md)");
    expect(qualityBar).toContain("## Buffett value bar (buffett-value.md)");

    expect(buffettSkill.body).toContain("capitalAllocation");
    expect(buffettSkill.body).toContain("debtToEquity");
    expect(buffettSkill.body).toContain("priceToFairValue");
    expect(buffettSkill.body).toContain("VERDICT: <BUY|SELL|HOLD|NONE>");
  });
});
