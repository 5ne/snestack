import * as fs from "fs";
import * as yaml from "js-yaml";

export interface SkillFrontmatter {
  name?: string;
  domain?: string;
  requires?: string[];
  references?: string[];
  type?: string;
  status?: string;
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
