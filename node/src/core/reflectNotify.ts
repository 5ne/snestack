import { readProposalFile } from "./featureRequests";

/** One domain's outcome from a `snestack reflect` run — the shape `reflect --json` prints. */
export interface DomainReflectResult {
  domain: string;
  /** False if the gate skipped the model call, or the domain has no improve-self skill yet. */
  ran: boolean;
  /** The gate's reasoning, or why the domain was skipped entirely. */
  reason: string;
  /** Absolute paths of newly written proposal files. */
  written: string[];
  /** Absolute paths of existing proposals a new one looked like a duplicate of (and so wasn't written). */
  skippedDuplicates: string[];
  /** Human-readable parse errors from malformed `## Feature Request:` sections. */
  parseErrors: string[];
}

/**
 * Builds the "new feature-request proposals" summary email `reflect-check.sh`
 * sends — one combined email across every domain that wrote something new,
 * each proposal with its `snestack feature approve <id>` command. Returns
 * null when nothing new was written anywhere (the expected, quiet case —
 * `reflect-check.sh` sends no email then).
 */
export function buildReflectEmail(results: DomainReflectResult[]): { subject: string; text: string } | null {
  const newFiles = results.flatMap((r) => r.written);
  const parseErrorCount = results.reduce((n, r) => n + r.parseErrors.length, 0);
  if (newFiles.length === 0 && parseErrorCount === 0) return null;

  const lines: string[] = [];
  for (const r of results) {
    for (const file of r.written) {
      const p = readProposalFile(file);
      if (!p) continue;
      lines.push(`[${r.domain}] ${p.title} (impact=${p.impact ?? "?"}, effort=${p.effort ?? "?"})`);
      lines.push(`  snestack feature approve ${p.slug}`);
      lines.push("");
    }
  }

  if (parseErrorCount > 0) {
    lines.push("Parse errors (a skill's output didn't match the expected `## Feature Request:` format):");
    for (const r of results) {
      for (const e of r.parseErrors) lines.push(`  [${r.domain}] ${e}`);
    }
    lines.push("");
  }

  const subject =
    newFiles.length > 0
      ? `snestack: ${newFiles.length} new improvement ${newFiles.length === 1 ? "proposal" : "proposals"}`
      : "snestack: improve-self output had parse errors";

  return { subject, text: lines.join("\n").trim() + "\n" };
}
