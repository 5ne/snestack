import * as fs from "fs";
import * as path from "path";
import domainsConfig from "../config/domains.json";
import type { ContextToolMap, GateFactsFn } from "./contextTools";
import type { DomainApiModule } from "./api/types";
import { loadSkillFile, type SkillFrontmatter } from "./skillLoader";
import { writeVerified } from "./safeWrite";
import { ValidationError } from "./errors";

export interface DomainConfig {
  /** Where this domain's skill markdown files live, relative to src/. */
  skillsDir: string;
  /** Module (relative to core/) exporting a `contextTools: ContextToolMap`. */
  contextToolsModule: string;
  /** Optional directory where this domain's scheduled scripts live, relative to src/. */
  scriptsDir?: string;
  /** Optional module (relative to src/) exporting `domainApi: DomainApiModule`. */
  apiModule?: string;
}

export interface DomainSkillSummary {
  domain: string;
  name: string;
  runnable: boolean;
  type: string | null;
  model: string;
  requires: string[];
  references: string[];
  hasGate: boolean;
  verdict: boolean;
  status: string | null;
}

export interface DomainSkillDetail {
  domain: string;
  name: string;
  runnable: boolean;
  frontmatter: SkillFrontmatter;
  body: string;
  references: Record<string, string>;
}

const REGISTERED_DOMAINS = domainsConfig as Record<string, DomainConfig>;

export function defaultNodeDir(): string {
  return path.resolve(__dirname, "..", "..");
}

export function listRegisteredDomains(): string[] {
  return Object.keys(REGISTERED_DOMAINS);
}

export function getDomainConfig(domain: string): DomainConfig {
  const cfg = REGISTERED_DOMAINS[domain];
  if (!cfg) {
    throw new Error(
      `Unknown domain "${domain}". Registered domains: ${Object.keys(REGISTERED_DOMAINS).join(", ")}`
    );
  }
  return cfg;
}

/**
 * Resolve a domain's `skillsDir` on disk. Checks `<cwd>/src/<skillsDir>` first
 * (for callers/tests running with a custom working directory) and falls back to
 * `<nodeDir>/src/<skillsDir>` so `snestack` works from any working directory.
 */
export function resolveDomainSkillsDir(domain: string, nodeDir?: string): string {
  const cfg = getDomainConfig(domain);
  if (nodeDir) {
    return path.join(nodeDir, "src", cfg.skillsDir);
  }
  const cwdCandidate = path.join(process.cwd(), "src", cfg.skillsDir);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  return path.join(defaultNodeDir(), "src", cfg.skillsDir);
}

/** Load a domain's contextTools map (dynamic import — resolves under both ts-node and compiled dist). */
export async function loadContextTools(domain: string): Promise<ContextToolMap> {
  const cfg = getDomainConfig(domain);
  const modulePath = path.join(__dirname, "..", cfg.contextToolsModule);
  const mod = (await import(modulePath)) as { contextTools: ContextToolMap };
  return mod.contextTools;
}

/** A domain's optional `gateFacts` function, or null if it doesn't define one. */
export async function loadGateFacts(domain: string): Promise<GateFactsFn | null> {
  const cfg = getDomainConfig(domain);
  const modulePath = path.join(__dirname, "..", cfg.contextToolsModule);
  const mod = (await import(modulePath)) as { gateFacts?: GateFactsFn };
  return mod.gateFacts ?? null;
}

/** Load a domain's optional `domainApi` module (`routes`, `registerCli`, `healthHooks`). */
export async function loadDomainApi(domain: string): Promise<DomainApiModule | null> {
  const cfg = getDomainConfig(domain);
  if (!cfg.apiModule) return null;
  const modulePath = path.join(__dirname, "..", cfg.apiModule);
  const mod = (await import(modulePath)) as { domainApi?: DomainApiModule };
  return mod.domainApi ?? null;
}

/** Load all registered domains' `domainApi` modules in registration order. */
export async function loadAllDomainApis(): Promise<Record<string, DomainApiModule>> {
  const out: Record<string, DomainApiModule> = {};
  for (const domain of listRegisteredDomains()) {
    const api = await loadDomainApi(domain);
    if (api) out[domain] = api;
  }
  return out;
}

/** Resolve a domain's registered `scriptsDir` on disk, or null if the domain has none. */
export function getDomainScriptsDir(domain: string, nodeDir = defaultNodeDir()): string | null {
  const cfg = getDomainConfig(domain);
  if (!cfg.scriptsDir) return null;
  return path.join(nodeDir, "src", cfg.scriptsDir);
}

/** Sorted `.sh` script filenames registered for `domain` (empty if none or dir missing). */
export function listDomainScripts(domain: string, nodeDir?: string): string[] {
  const dir = getDomainScriptsDir(domain, nodeDir);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sh"))
    .sort();
}

/** Map every registered domain to its sorted `.sh` script filenames. */
export function listAllDomainScripts(nodeDir?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const domain of listRegisteredDomains()) {
    out[domain] = listDomainScripts(domain, nodeDir);
  }
  return out;
}

function isSafeMarkdownSlug(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.includes("..");
}

function isRunnableSkill(fileStem: string, fm: SkillFrontmatter): boolean {
  if (fileStem.toUpperCase() === "INDEX") return false;
  if (fm.type && ["vision", "pm", "eng"].includes(String(fm.type))) return false;
  return Boolean(fm.domain || fm.name);
}

/** List skills in `domain` (`includeDocs` also returns INDEX/vision/pm/eng files). */
export function listDomainSkills(
  domain: string,
  opts?: { includeDocs?: boolean; nodeDir?: string }
): DomainSkillSummary[] {
  const dir = resolveDomainSkillsDir(domain, opts?.nodeDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const summaries: DomainSkillSummary[] = [];
  for (const f of files) {
    const stem = f.slice(0, -3);
    const { frontmatter } = loadSkillFile(path.join(dir, f));
    const runnable = isRunnableSkill(stem, frontmatter);
    if (!runnable && !opts?.includeDocs) continue;
    summaries.push({
      domain,
      name: stem,
      runnable,
      type: typeof frontmatter.type === "string" ? frontmatter.type : null,
      model: typeof frontmatter.model === "string" ? frontmatter.model : "normal",
      requires: Array.isArray(frontmatter.requires) ? frontmatter.requires : [],
      references: Array.isArray(frontmatter.references) ? frontmatter.references : [],
      hasGate: Boolean(frontmatter.gate),
      verdict: frontmatter.verdict === true,
      status: typeof frontmatter.status === "string" ? frontmatter.status : null,
    });
  }
  return summaries;
}

/** Load one skill's frontmatter, markdown body, and referenced markdown files. */
export function loadDomainSkillDetail(
  domain: string,
  skillName: string,
  nodeDir?: string
): DomainSkillDetail {
  if (!isSafeMarkdownSlug(skillName)) {
    throw new ValidationError(`Invalid skill name "${skillName}"`);
  }
  const skillsDir = resolveDomainSkillsDir(domain, nodeDir);
  const skillPath = path.join(skillsDir, `${skillName}.md`);
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill not found: ${domain}/${skillName} (looked in ${skillPath})`);
  }
  const { frontmatter, body } = loadSkillFile(skillPath);
  const references: Record<string, string> = {};
  for (const refName of frontmatter.references ?? []) {
    const refPath = path.join(skillsDir, "references", `${refName}.md`);
    if (fs.existsSync(refPath)) {
      references[refName] = fs.readFileSync(refPath, "utf8");
    }
  }
  return {
    domain,
    name: skillName,
    runnable: isRunnableSkill(skillName, frontmatter),
    frontmatter,
    body,
    references,
  };
}

/** List shared `references/*.md` names inside a domain's `skills/references/` directory. */
export function listDomainReferences(domain: string, nodeDir?: string): string[] {
  const refsDir = path.join(resolveDomainSkillsDir(domain, nodeDir), "references");
  if (!fs.existsSync(refsDir)) return [];
  return fs
    .readdirSync(refsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function readDomainReference(domain: string, refName: string, nodeDir?: string): { domain: string; name: string; path: string; content: string } {
  if (!isSafeMarkdownSlug(refName)) {
    throw new ValidationError(`Invalid reference name "${refName}"`);
  }
  const refPath = path.join(resolveDomainSkillsDir(domain, nodeDir), "references", `${refName}.md`);
  if (!fs.existsSync(refPath)) {
    throw new Error(`Skill not found: reference ${domain}/${refName} (looked in ${refPath})`);
  }
  return {
    domain,
    name: refName,
    path: refPath,
    content: fs.readFileSync(refPath, "utf8"),
  };
}

export function writeDomainReference(
  domain: string,
  refName: string,
  content: string,
  nodeDir?: string
): { domain: string; name: string; path: string } {
  if (!isSafeMarkdownSlug(refName)) {
    throw new ValidationError(`Invalid reference name "${refName}"`);
  }
  const refPath = path.join(resolveDomainSkillsDir(domain, nodeDir), "references", `${refName}.md`);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  const problem = writeVerified(refPath, content);
  if (problem) {
    throw new Error(`Failed to write reference ${domain}/${refName}: ${problem}`);
  }
  return { domain, name: refName, path: refPath };
}
