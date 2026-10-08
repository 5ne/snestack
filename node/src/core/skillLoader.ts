import * as fs from "fs";
import * as yaml from "js-yaml";
import type { GateConfig } from "./gate";

export interface SkillFrontmatter {
  name?: string;
  domain?: string;
  requires?: string[];
  references?: string[];
  type?: string;
  status?: string;
  /** Cost tier for this skill's model call: "cheap" | "normal" | "expensive". Defaults to "normal". */
  model?: string;
  /** When to run this skill at all — see core/gate.ts. Omit to always run. */
  gate?: GateConfig;
  /** The skill must end with a `VERDICT: LABEL | confidence | reasoning` line — see core/verdict.ts. */
  verdict?: boolean;
  /** Output token budget for this skill's model call. Defaults to runPrompt's own default (8000) if unset. */
  maxTokens?: number;
  [key: string]: unknown;
}

export interface LoadedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse a skill markdown file's YAML frontmatter + body. Frontmatter is optional. */
export function loadSkillFile(filePath: string): LoadedSkill {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter = (yaml.load(match[1]) as SkillFrontmatter) ?? {};
  const body = raw.slice(match[0].length);
  return { frontmatter, body };
}
