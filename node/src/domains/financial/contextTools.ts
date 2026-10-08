import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../../core/config";
import { Db } from "../../core/db";
import type { ContextToolMap } from "../../core/contextTools";
import { QuoteAgent } from "./agents/quoteAgent";
import { EquityAgent } from "./agents/equityAgent";

export { gateFacts } from "./gate";

/**
 * The financial domain's contextTools map — what the skill frontmatter's
 * `requires: [quote, fundamentals, brain]` actually resolves to. core/ never
 * imports this file directly; the harness loads it dynamically by domain name
 * via config/domains.json.
 */
export const contextTools: ContextToolMap = {
  quote: async (subject) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    try {
      // Passing db lets QuoteAgent reuse today's RSI/MA if data-dump (or an
      // earlier run-skill call today) already computed them, instead of
      // burning another Twelve Data request for the same numbers.
      return await new QuoteAgent(config.getFinnhubApiKey(), db).safeAnalyze(subject.toUpperCase());
    } finally {
      db.close();
    }
  },

  fundamentals: async (subject) => {
    return new EquityAgent().safeAnalyze(subject.toUpperCase());
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
