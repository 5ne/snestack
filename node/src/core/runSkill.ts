import * as fs from "fs";
import * as path from "path";
import { loadSkillFile } from "./skillLoader";
import { getDomainConfig, loadContextTools } from "./domainRegistry";
import { runPrompt } from "./executor";
import { getConfig } from "./config";
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
}

/** Where this domain's skill markdown actually lives on disk (always under src/, even in a compiled build). */
function resolveSkillsDir(skillsDirRelativeToSrc: string): string {
  return path.join(process.cwd(), "src", skillsDirRelativeToSrc);
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
  const domainConfig = getDomainConfig(domain);
  const skillsDir = resolveSkillsDir(domainConfig.skillsDir);
  const skillPath = path.join(skillsDir, `${skillName}.md`);
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill not found: ${domain}/${skillName} (looked in ${skillPath})`);
  }

  const { frontmatter, body } = loadSkillFile(skillPath);
  const requires = frontmatter.requires ?? [];
  const references = frontmatter.references ?? [];

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

  logger.debug(`Running skill "${domain}/${skillName}" for ${subject}`);
  const { output } = await runPrompt(getConfig().getClaudeApiKey(), GENERIC_SYSTEM_PROMPT, userPrompt);

  return { domain, skill: skillName, subject, output };
}
