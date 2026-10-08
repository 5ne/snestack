import * as path from "path";
import domainsConfig from "../config/domains.json";
import type { ContextToolMap, GateFactsFn } from "./contextTools";

export interface DomainConfig {
  /** Where this domain's skill markdown files live, relative to src/. */
  skillsDir: string;
  /** Module (relative to core/) exporting a `contextTools: ContextToolMap`. */
  contextToolsModule: string;
}

const REGISTERED_DOMAINS = domainsConfig as Record<string, DomainConfig>;

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
