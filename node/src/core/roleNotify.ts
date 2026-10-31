import type { ProposalFile } from "./featureRequests";

export type Role = "pm" | "eng";

export interface RoleEmailInput {
  role: Role;
  /** The agent session (or its gate/setup) failed; `failureReason` is a short tail of its stderr / error text. */
  failed: boolean;
  failureReason?: string | null;
  /** The session's final message (report.md). */
  report: string;
  /** PM only: proposals that exist now but did not exist before the session started. */
  newProposals?: ProposalFile[];
}

const REPORT_EXCERPT_CHARS = 3000;

function excerpt(text: string): string {
  const t = text.trim();
  return t.length > REPORT_EXCERPT_CHARS ? `${t.slice(0, REPORT_EXCERPT_CHARS)}\n…(truncated; full report in the run folder)` : t;
}

/**
 * Builds the email for a finished PM or eng run, or null when there is nothing worth the owner's attention
 * (a PM run that wrote no new proposals; silence on a quiet day, same rule the old reflect-notify followed).
 * A failed run always produces an email: a usage limit or expired login must not fail silently.
 */
export function buildRoleEmail(input: RoleEmailInput): { subject: string; text: string } | null {
  const label = input.role === "pm" ? "PM" : "eng";

  if (input.failed) {
    const reason = (input.failureReason ?? "").trim() || "no error text captured";
    const limit = /usage limit|rate limit/i.test(reason) ? " (subscription usage limit; the next run retries)" : "";
    return {
      subject: `snestack ${label}: run FAILED${limit ? " (usage limit)" : ""}`,
      text: `The ${label} run failed${limit}.\n\n${reason.slice(-1500)}\n`,
    };
  }

  if (input.role === "pm") {
    const proposals = input.newProposals ?? [];
    if (proposals.length === 0) return null;
    const lines: string[] = [];
    for (const p of proposals) {
      lines.push(`[${p.domain || "?"}] ${p.title} (impact=${p.impact ?? "?"}, effort=${p.effort ?? "?"})`);
      lines.push(`  snestack feature approve ${p.slug}${p.domain === "_system" ? " --domain _system" : ""}`);
      lines.push("");
    }
    return {
      subject: `snestack PM: ${proposals.length} new feature ${proposals.length === 1 ? "request" : "requests"}`,
      text: `${lines.join("\n")}\nPM report:\n${excerpt(input.report)}\n`,
    };
  }

  // eng sessions only start when something was approved, so a finished run is always worth a note.
  return { subject: "snestack eng: run finished", text: `${excerpt(input.report) || "(the session produced no final message)"}\n` };
}
