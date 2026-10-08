import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../../core/config";
import { Db } from "../../core/db";
import type { GateFacts } from "../../core/gate";
import { defaultReportsDir } from "./agents/equityAgent";

/** Signal-reasoning prefix each skill's results are recorded under (set by build-signals). */
const SKILL_PREFIX: Record<string, string> = {
  "long-term-quality": "[Long-term]",
  "swing-trading-large-cap": "[Swing]",
};

/** A stored quote older than this is too stale to gate on; the skill just runs. */
const MAX_QUOTE_AGE_DAYS = 4;
const DAY_MS = 86_400_000;

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Facts for core/gate.ts, read from data the pipeline already has — today's
 * data-dump wrote the latest quote and RSI into the DB, and past results are
 * the signals table — so deciding costs no API calls.
 */
export function computeGateFacts(
  db: Db,
  skillName: string,
  ticker: string,
  opts: { reportsDir: string; brainFile: string; now?: Date }
): GateFacts {
  const now = opts.now ?? new Date();
  const T = ticker.toUpperCase();

  const latest = db.getLatestQuote(T);
  const quoteFresh = latest && now.getTime() - Date.parse(`${latest.date}T12:00:00Z`) <= MAX_QUOTE_AGE_DAYS * DAY_MS;

  const prefix = SKILL_PREFIX[skillName];
  const lastSignal = prefix ? db.getLastSignalWithPrefix(T, prefix) : undefined;
  const lastRunAt = lastSignal ? new Date(lastSignal.date) : null;

  let lastRunPrice: number | null = null;
  if (lastRunAt) {
    const lastDay = lastRunAt.getTime();
    let best = Infinity;
    for (const q of db.getQuotes(T, 250)) {
      const gap = Math.abs(Date.parse(`${q.date}T12:00:00Z`) - lastDay);
      if (gap < best && gap <= 3 * DAY_MS) {
        best = gap;
        lastRunPrice = q.close;
      }
    }
  }

  const inputsChanged =
    lastRunAt != null &&
    Math.max(mtime(path.join(opts.reportsDir, `${T}-morningstar.pdf`)), mtime(opts.brainFile)) > lastRunAt.getTime();

  return {
    now,
    rsi: quoteFresh ? (latest!.rsi ?? null) : null,
    price: quoteFresh ? latest!.close : null,
    lastRunAt,
    lastRunPrice,
    inputsUpdatedAfterLastRun: inputsChanged,
  };
}

export async function gateFacts(skillName: string, subject: string): Promise<GateFacts> {
  const config = getConfig();
  const db = new Db(config.getDatabasePath());
  try {
    return computeGateFacts(db, skillName, subject, {
      reportsDir: defaultReportsDir(),
      brainFile: path.join(
        config.getBrainRoot(),
        "financial",
        "brain",
        "investing",
        "public",
        "companies",
        `${subject.toUpperCase()}.md`
      ),
    });
  } finally {
    db.close();
  }
}
