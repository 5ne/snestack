import * as path from "path";
import type { RunExpectation } from "../../core/runCheck";

// Don't expect runs for an automation before run logging (or that automation's
// own cadence split) existed — see node/README.md's cron table / pipeline history.
const RUN_LOG_SINCE = "2026-10-07";
const SPLIT_CADENCE_SINCE = "2026-10-09";

/**
 * The financial domain's registered automations, as `run-check`-style
 * expectations (graceHour values assume this runs on the same machine/timezone
 * as cron — America/Los_Angeles). Shared by the `run-check` CLI command and the
 * `improve-self` skill's `reflectionDigest` context tool so the two definitions
 * of "what financial automations exist" never drift apart.
 */
export function financialRunExpectations(brainRoot: string): RunExpectation[] {
  return [
    {
      name: "financial",
      runsRoot: path.join(brainRoot, "financial", "signals"),
      expectedOn: (d) => d.getDay() >= 1 && d.getDay() <= 5, // cron: 2:30pm PT, after data-refresh-daily.sh
      graceHour: 16,
      since: RUN_LOG_SINCE,
    },
    {
      name: "financial-daily-refresh",
      runsRoot: path.join(brainRoot, "financial", "runs", "data-refresh-daily"),
      expectedOn: (d) => d.getDay() >= 1 && d.getDay() <= 5, // cron: 2pm PT, nightly, before financial-daily
      graceHour: 15,
      since: SPLIT_CADENCE_SINCE,
    },
    {
      name: "financial-intraday",
      runsRoot: path.join(brainRoot, "financial", "runs", "intraday"),
      expectedOn: (d) => d.getDay() >= 1 && d.getDay() <= 5, // cron: every 30 min, 6:30am-1pm PT (market hours)
      graceHour: 11, // a couple hours into market open before flagging a short day
      since: SPLIT_CADENCE_SINCE,
      minRunsPerDay: 3,
    },
    {
      name: "financial-swing-check",
      runsRoot: path.join(brainRoot, "financial", "runs", "swing-check"),
      expectedOn: (d) => d.getDay() >= 1 && d.getDay() <= 5, // cron: hourly, 7am-1pm PT (market hours)
      graceHour: 11,
      since: SPLIT_CADENCE_SINCE,
      minRunsPerDay: 3,
    },
  ];
}

/** Every runsRoot financialRunExpectations knows about — for the run-summaries digest source. */
export function financialRunRoots(brainRoot: string): string[] {
  return financialRunExpectations(brainRoot).map((e) => e.runsRoot);
}
