import type { ContextToolMap } from "../../core/contextTools";
import { timelineForYear } from "./tools/timelineClient";

/**
 * The travel domain's contextTools. `subject` is a 4-digit year (e.g. "2024").
 * There is deliberately no `gmail` context tool here — this harness has no
 * Gmail access wired up, so the actual email research this skill needs has to
 * happen wherever Gmail is available. `timeline` supplies the one piece of
 * context this harness *can* fetch deterministically: candidate away-from-home
 * date ranges from the Google Maps Timeline export, pre-clustered so the
 * skill (run wherever Gmail lives) doesn't have to sift 3000+ raw entries.
 */
export const contextTools: ContextToolMap = {
  timeline: async (subject) => {
    const year = parseInt(subject, 10);
    if (!Number.isInteger(year) || subject.length !== 4) {
      throw new Error(`travel domain subject must be a 4-digit year, got "${subject}"`);
    }
    return timelineForYear(year);
  },
};
