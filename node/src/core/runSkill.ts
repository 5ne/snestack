import * as fs from "fs";
import * as path from "path";
import { loadSkillFile } from "./skillLoader";
import { getDomainConfig, loadContextTools, loadGateFacts } from "./domainRegistry";
import { evaluateGate, type GateDecision } from "./gate";
import { parseVerdict, type Verdict } from "./verdict";
import { logRunEvent } from "./runLog";
import { runPrompt } from "./executor";
import { getConfig, MODEL_TIERS, type ModelTier } from "./config";
import { getLogger } from "./logger";

const logger = getLogger("runSkill");

const GENERIC_SYSTEM_PROMPT =
  "You are executing a single named skill for a personal decision-support system. " +
  "The skill definition below states its own purpose, judgment process, and desired " +
  "output for this subject — follow it exactly. Use only the context provided; do not " +
  "invent data you weren't given, and say so explicitly if something you need is missing.";

export interface SkillRunResult {
  domain: string;
  skill: string;
  subject: string;
  output: string;
  stopReason: string | null;
  outputTokensUsed: number | null;
  /** True if the skill's frontmatter says it must end with a VERDICT line. */
  verdictRequired: boolean;
  /** The parsed VERDICT line, if the output has a valid one. */
  verdict: Verdict | null;
}

export interface AssembledSkillPrompt {
  systemPrompt: string;
  userPrompt: string;
  /** Cost tier from the skill's frontmatter `model:` (default "normal"). */
  tier: ModelTier;
  /** Output token budget from the skill's frontmatter `maxTokens:`, if set. */
  maxTokens?: number;
  /** Whether the skill must end with a VERDICT line (frontmatter `verdict: true`). */
  verdictRequired: boolean;
}

/** Where this domain's skill markdown actually lives on disk (always under src/, even in a compiled build). */
function resolveSkillsDir(skillsDirRelativeToSrc: string): string {
  return path.join(process.cwd(), "src", skillsDirRelativeToSrc);
}

/**
 * Load a skill's frontmatter + body and resolve its `requires`/`references` via
 * the domain's context tools into a system + user prompt — everything
 * `runSkill` sends to the model, without actually calling it. Split out so a
 * caller that can't (or shouldn't) run the model itself — e.g. a skill that
 * needs data this harness has no access to, like Gmail — can still get the
 * fully-assembled prompt to run somewhere that does.
 */
export async function assembleSkillPrompt(
  domain: string,
  skillName: string,
  subject: string
): Promise<AssembledSkillPrompt> {
  const domainConfig = getDomainConfig(domain);
  const skillsDir = resolveSkillsDir(domainConfig.skillsDir);
  const skillPath = path.join(skillsDir, `${skillName}.md`);
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill not found: ${domain}/${skillName} (looked in ${skillPath})`);
  }

  const { frontmatter, body } = loadSkillFile(skillPath);
  const requires = frontmatter.requires ?? [];
  const references = frontmatter.references ?? [];
  const tier = frontmatter.model ?? "normal";
  if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`Skill ${domain}/${skillName} has invalid model "${tier}" — expected one of: ${MODEL_TIERS.join(", ")}`);
  }

  const contextTools = await loadContextTools(domain);
  const contextEntries = await Promise.all(
    requires.map(async (key): Promise<[string, unknown]> => {
      const tool = contextTools[key];
      if (!tool) {
        logger.warn(`Skill "${skillName}" requires unknown context tool "${key}" — skipping`);
        return [key, null];
      }
      return [key, await tool(subject)];
    })
  );

  const referenceSections = references
    .map((refName) => {
      const refPath = path.join(skillsDir, "references", `${refName}.md`);
      if (!fs.existsSync(refPath)) {
        logger.warn(`Skill "${skillName}" references unknown reference "${refName}" — skipping`);
        return null;
      }
      return `### REFERENCE: ${refName}\n${fs.readFileSync(refPath, "utf8")}`;
    })
    .filter((s): s is string => s !== null);

  const contextSections = contextEntries.map(
    ([key, value]) => `### ${key.toUpperCase()}\n${value == null ? "(unavailable)" : JSON.stringify(value, null, 2)}`
  );

  const userPrompt = [
    `SUBJECT: ${subject}`,
    "",
    "SKILL DEFINITION:",
    body.trim(),
    "",
    "CONTEXT:",
    [...contextSections, ...referenceSections].join("\n\n"),
  ].join("\n");

  return {
    systemPrompt: GENERIC_SYSTEM_PROMPT,
    userPrompt,
    tier: tier as ModelTier,
    maxTokens: frontmatter.maxTokens,
    verdictRequired: frontmatter.verdict === true,
  };
}

/**
 * Load a skill's frontmatter + body, resolve its `requires`/`references` via the
 * domain's context tools, and run the assembled prompt through the model.
 * This is the harness's one entry point — callers never touch the loader,
 * registry, or executor directly.
 */
export async function runSkill(
  domain: string,
  skillName: string,
  subject: string
): Promise<SkillRunResult> {
  const { systemPrompt, userPrompt, tier, maxTokens, verdictRequired } = await assembleSkillPrompt(domain, skillName, subject);
  logger.debug(`Running skill "${domain}/${skillName}" for ${subject} (tier: ${tier})`);
  const { output, stopReason, outputTokensUsed } = await runPrompt(
    getConfig().getClaudeApiKey(),
    systemPrompt,
    userPrompt,
    { tier, maxTokens, label: `${domain}/${skillName} ${subject}` }
  );

  const verdict = parseVerdict(output);
  // Recorded so run-check --cost can measure how often a model call just repeats the previous verdict.
  if (verdict) {
    logRunEvent("verdict", {
      skill: `${domain}/${skillName}`,
      subject,
      label: verdict.label,
      confidence: verdict.confidence,
    });
  }

  return {
    domain,
    skill: skillName,
    subject,
    output,
    stopReason,
    outputTokensUsed,
    verdictRequired,
    verdict,
  };
}

/**
 * Decide, with no model call, whether this skill is worth running for this
 * subject right now, using the skill's own `gate:` triggers and the domain's
 * facts. Fails open: with no gate, no facts, or any error, the skill runs.
 * The decision is recorded in the run log either way.
 */
export async function evaluateSkillGate(domain: string, skillName: string, subject: string): Promise<GateDecision> {
  let decision: GateDecision;
  try {
    const skillPath = path.join(resolveSkillsDir(getDomainConfig(domain).skillsDir), `${skillName}.md`);
    const { frontmatter } = loadSkillFile(skillPath);
    const factsFn = frontmatter.gate ? await loadGateFacts(domain) : null;
    decision =
      frontmatter.gate && factsFn
        ? evaluateGate(frontmatter.gate, await factsFn(skillName, subject))
        : { run: true, reasons: ["no gate configured"] };
  } catch (e) {
    decision = { run: true, reasons: [`gate check failed (${String(e).slice(0, 120)}); running anyway`] };
  }
  logRunEvent("gate", { skill: `${domain}/${skillName}`, subject, run: decision.run, reasons: decision.reasons });
  return decision;
}
