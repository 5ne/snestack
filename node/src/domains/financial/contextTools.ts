import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../../core/config";
import type { ContextToolMap } from "../../core/contextTools";
import { QuoteAgent } from "./agents/quoteAgent";
import { EquityAgent } from "./agents/equityAgent";

/**
 * The financial domain's contextTools map — what the skill frontmatter's
 * `requires: [quote, fundamentals, brain]` actually resolves to. core/ never
 * imports this file directly; the harness loads it dynamically by domain name
 * via config/domains.json.
 */
export const contextTools: ContextToolMap = {
  quote: async (subject) => {
    const config = getConfig();
    return new QuoteAgent(config.getFinnhubApiKey()).safeAnalyze(subject);
  },

  fundamentals: async (subject) => {
    return new EquityAgent().safeAnalyze(subject);
  },

  brain: async (subject) => {
    const brainRoot = getConfig().getBrainRoot();
    const file = path.join(
      brainRoot,
      "financial",
      "brain",
      "investing",
      "public",
      "companies",
      `${subject.toUpperCase()}.md`
    );
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  },
};
