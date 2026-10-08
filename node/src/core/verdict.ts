/**
 * Skills that feed automation end with one machine-readable line:
 *
 *   VERDICT: <LABEL> | <confidence 0-1> | <one or two sentences>
 *
 * so downstream code can read the result without a second model call.
 * Parsing is deterministic; a skill with `verdict: true` in its frontmatter
 * fails loudly (see run-skill) if the line is missing or malformed.
 */

export interface Verdict {
  label: string;
  confidence: number;
  reasoning: string;
}

const VERDICT_LINE = /^\s*\**VERDICT:\**\s*([A-Za-z_-]+)\s*\|\s*([0-9]*\.?[0-9]+)\s*\|\s*(.+?)\s*$/gm;

/** The last well-formed VERDICT line in `output`, or null. */
export function parseVerdict(output: string): Verdict | null {
  let found: Verdict | null = null;
  for (const m of output.matchAll(VERDICT_LINE)) {
    const confidence = parseFloat(m[2]);
    if (!isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    found = { label: m[1].toUpperCase(), confidence, reasoning: m[3].replace(/\*+$/, "").trim() };
  }
  return found;
}
