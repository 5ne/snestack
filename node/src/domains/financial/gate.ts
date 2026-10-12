import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../../core/config";
import { Db } from "../../core/db";
import type { GateFacts } from "../../core/gate";
import { readLastReflectRun, hasNewRunsSince } from "../../core/reflect";
import { defaultReportsDir } from "./agents/equityAgent";
import { financialRunRoots } from "./runExpectations";

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
  let lastRunRsi: number | null = null;
  if (lastRunAt) {
    const lastDay = lastRunAt.getTime();
    let best = Infinity;
    for (const q of db.getQuotes(T, 250)) {
      const gap = Math.abs(Date.parse(`${q.date}T12:00:00Z`) - lastDay);
      if (gap < best && gap <= 3 * DAY_MS) {
        best = gap;
        lastRunPrice = q.close;
        lastRunRsi = q.rsi ?? null;
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
    lastRunRsi,
    inputsUpdatedAfterLastRun: inputsChanged,
  };
}

/**
 * `improve-self` reflects on the whole domain, not one ticker, so it has no
 * per-ticker signal row to read a last-run timestamp from — it gets its own
 * marker file (`core/reflect.ts`'s `readLastReflectRun`/`recordReflectRun`)
 * instead, and `inputsUpdated` means "has any automation produced a new
 * run.json since the last reflect run" rather than "did a report/brain file
 * change".
 */
export function improveSelfGateFacts(now: Date = new Date()): GateFacts {
  const brainRoot = getConfig().getBrainRoot();
  const lastRunAt = readLastReflectRun(brainRoot, "financial");
  return {
    now,
    rsi: null,
    price: null,
    lastRunAt,
    lastRunPrice: null,
    lastRunRsi: null,
    inputsUpdatedAfterLastRun: hasNewRunsSince(financialRunRoots(brainRoot), lastRunAt),
  };
}

export async function gateFacts(skillName: string, subject: string): Promise<GateFacts> {
  if (skillName === "improve-self") return improveSelfGateFacts();

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
