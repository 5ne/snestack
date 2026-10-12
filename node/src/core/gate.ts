/**
 * A gate decides, before any model call, whether a skill is worth running right
 * now. Skills declare their own triggers in frontmatter (`gate:`); a domain
 * supplies the facts (see `gateFacts` in its contextTools module). Pure and
 * deterministic: no model, no network. Any doubt fails open (the skill runs).
 */

export interface GateConfig {
  /** Run when the subject's RSI is below this (oversold). */
  rsiBelow?: number;
  /** Run when the subject's RSI is above this (overbought). */
  rsiAbove?: number;
  /** Run when the price has moved at least this many percent since the last run. */
  priceMovePct?: number;
  /** Always run if the last run was at least this many days ago. */
  maxAgeDays?: number;
  /** Run when the skill's inputs (reports, notes) changed since the last run. */
  inputsUpdated?: boolean;
  /**
   * When set, an RSI-threshold trigger only counts if RSI has moved at least this many
   * points since the last run — otherwise a ticker sitting at an extreme re-triggers a
   * fresh (billed) model call on every single check, forever, with nothing new to say.
   * Only suppresses the RSI reason specifically; any other trigger (price move, age,
   * inputs updated) still fires normally.
   */
  minRsiMoveToRerun?: number;
}

export interface GateFacts {
  now: Date;
  rsi: number | null;
  price: number | null;
  /** When this skill last produced a result for the subject; null if never. */
  lastRunAt: Date | null;
  /** The subject's price at that time, if known. */
  lastRunPrice: number | null;
  /** The subject's RSI at that time, if known. */
  lastRunRsi: number | null;
  inputsUpdatedAfterLastRun: boolean;
}

export interface GateDecision {
  run: boolean;
  reasons: string[];
}

const DAY_MS = 86_400_000;

export function evaluateGate(cfg: GateConfig | undefined, facts: GateFacts): GateDecision {
  if (!cfg) return { run: true, reasons: ["no gate configured"] };

  const usesRsi = cfg.rsiBelow != null || cfg.rsiAbove != null;
  const stateful = cfg.priceMovePct != null || cfg.maxAgeDays != null || cfg.inputsUpdated === true;

  // Without the data to judge, run: a wasted call costs cents, a missed signal costs more.
  if (usesRsi && facts.rsi == null) return { run: true, reasons: ["no RSI data available (running to be safe)"] };

  const triggers: string[] = [];
  const rsiQuiet: string[] = [];
  if (facts.rsi != null) {
    const belowHit = cfg.rsiBelow != null && facts.rsi < cfg.rsiBelow;
    const aboveHit = cfg.rsiAbove != null && facts.rsi > cfg.rsiAbove;
    if (belowHit || aboveHit) {
      const band = belowHit ? `below ${cfg.rsiBelow}` : `above ${cfg.rsiAbove}`;
      const moveSinceLastRun =
        cfg.minRsiMoveToRerun != null && facts.lastRunRsi != null ? Math.abs(facts.rsi - facts.lastRunRsi) : null;
      if (moveSinceLastRun != null && moveSinceLastRun < cfg.minRsiMoveToRerun!) {
        rsiQuiet.push(
          `RSI ${facts.rsi} is still ${band}, but only moved ${moveSinceLastRun.toFixed(1)} since the last run's ${facts.lastRunRsi} (need ${cfg.minRsiMoveToRerun})`
        );
      } else {
        triggers.push(`RSI ${facts.rsi} is ${band}`);
      }
    }
  }

  const quiet: string[] = [];
  if (stateful) {
    if (!facts.lastRunAt) {
      triggers.push("no previous run on record");
    } else {
      const ageDays = (facts.now.getTime() - facts.lastRunAt.getTime()) / DAY_MS;
      if (cfg.maxAgeDays != null) {
        if (ageDays >= cfg.maxAgeDays) triggers.push(`last run was ${ageDays.toFixed(1)} days ago (limit ${cfg.maxAgeDays})`);
        else quiet.push(`last run ${ageDays.toFixed(1)}d ago`);
      }
      if (cfg.priceMovePct != null && facts.price != null && facts.lastRunPrice) {
        const move = Math.abs(facts.price / facts.lastRunPrice - 1) * 100;
        if (move >= cfg.priceMovePct) triggers.push(`price moved ${move.toFixed(1)}% since the last run (limit ${cfg.priceMovePct}%)`);
        else quiet.push(`price moved ${move.toFixed(1)}%`);
      }
      if (cfg.inputsUpdated) {
        if (facts.inputsUpdatedAfterLastRun) triggers.push("inputs (report or notes) changed since the last run");
        else quiet.push("inputs unchanged");
      }
    }
  }

  if (triggers.length > 0) return { run: true, reasons: triggers };

  const parts: string[] = [];
  if (usesRsi && facts.rsi != null && rsiQuiet.length === 0) {
    const band =
      cfg.rsiBelow != null && cfg.rsiAbove != null
        ? `${cfg.rsiBelow}-${cfg.rsiAbove}`
        : cfg.rsiBelow != null
          ? `>= ${cfg.rsiBelow}`
          : `<= ${cfg.rsiAbove}`;
    parts.push(`RSI ${facts.rsi} inside ${band}`);
  }
  return { run: false, reasons: [`no trigger: ${[...parts, ...rsiQuiet, ...quiet].join(", ")}`] };
}
