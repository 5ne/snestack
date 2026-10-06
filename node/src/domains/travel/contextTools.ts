import type { ContextToolMap } from "../../core/contextTools";
import { timelineForYear } from "./tools/timelineClient";
import { searchTravelEmailsForYear } from "./tools/gmailClient";

/**
 * The travel domain's contextTools. `subject` is a 4-digit year (e.g. "2024").
 * `timeline` supplies candidate away-from-home date ranges from the Google
 * Maps Timeline export, pre-clustered so the skill doesn't have to sift
 * 3000+ raw entries. `gmail` runs a fixed set of broad searches (see
 * tools/gmailClient.ts) and returns metadata + snippets only — never full
 * bodies, both to avoid the tracking-link bloat in marketing/notification
 * email and to keep this a bounded, deterministic fetch rather than the
 * open-ended, many-round-trip search a human (or an agentic session) would
 * do by hand. That's also why this is strictly lower-fidelity than a manual
 * run: no follow-up searches on ambiguous threads, no full-body reads to
 * resolve conflicting dates. See catalog-trip-year.md's own note on this.
 */
export const contextTools: ContextToolMap = {
  timeline: async (subject) => {
    const year = parseYear(subject);
    return timelineForYear(year);
  },
  gmail: async (subject) => {
    const year = parseYear(subject);
    return searchTravelEmailsForYear(year);
  },
};

function parseYear(subject: string): number {
  const year = parseInt(subject, 10);
  if (!Number.isInteger(year) || subject.length !== 4) {
    throw new Error(`travel domain subject must be a 4-digit year, got "${subject}"`);
  }
  return year;
}
