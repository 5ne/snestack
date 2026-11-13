import * as fs from "fs";
import * as path from "path";
import domainsConfig from "../config/domains.json";
import type { ContextToolMap, GateFactsFn } from "./contextTools";

export interface DomainConfig {
  /** Where this domain's skill markdown files live, relative to src/. */
  skillsDir: string;
  /** Module (relative to core/) exporting a `contextTools: ContextToolMap`. */
  contextToolsModule: string;
  /** Optional directory where this domain's scheduled scripts live, relative to src/. */
  scriptsDir?: string;
}

const REGISTERED_DOMAINS = domainsConfig as Record<string, DomainConfig>;

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

/** Resolve a domain's registered `scriptsDir` on disk, or null if the domain has none. */
export function getDomainScriptsDir(domain: string, nodeDir = path.resolve(__dirname, "..", "..")): string | null {
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
