import { gmail, gmail_v1 } from "@googleapis/gmail";
import { getAuthorizedClient } from "../googleAuth";
import { getLogger } from "../../../core/logger";

const logger = getLogger("GmailClient");

export interface EmailSummary {
  messageId: string;
  threadId: string;
  date: string; // ISO timestamp, from the message's internalDate
  from: string;
  subject: string;
  snippet: string;
  matchedQuery: string;
}

/**
 * Fixed set of broad search queries covering the categories a trip's paper
 * trail tends to show up in. Deliberately broad per catalog-trip-year.md's
 * own judgment ("search broadly first... not just obvious vacation
 * keywords") — narrowing this list is how past trips get missed.
 */
export const QUERY_TEMPLATES: Array<{ name: string; query: string }> = [
  {
    name: "flights",
    query:
      '(flight OR itinerary OR "boarding pass" OR "e-ticket" OR confirmation) ' +
      '(united OR delta OR southwest OR alaska OR "american airlines" OR jetblue OR frontier OR virgin OR lufthansa)',
  },
  {
    name: "hotels",
    query: '(hotel OR reservation OR "your stay" OR booking OR airbnb OR vrbo OR expedia) confirmation',
  },
  {
    name: "car-rentals",
    query: "(avis OR hertz OR budget OR enterprise OR national OR sixt) (reservation OR confirmation OR rental)",
  },
  {
    name: "dining",
    query: '(opentable OR resy OR sevenrooms OR "reservation confirmed") -newsletter',
  },
  {
    name: "rideshare",
    query: "(uber OR lyft) receipt",
  },
  {
    name: "foreign-transactions",
    query: '"foreign transaction" OR "international transaction"',
  },
  {
    name: "cancellations",
    query: '(cancellation OR cancelled OR canceled OR refund) (hotel OR flight OR reservation OR booking)',
  },
];

export function dateRangeForYear(year: number): { after: string; before: string } {
  return { after: `${year}/01/01`, before: `${year + 1}/01/01` };
}

/**
 * Run `items` through `fn` at most `concurrency` at a time, retrying any call
 * that fails with a 429/quota error (exponential backoff, a few attempts)
 * before giving up on that one item. Keeps this a well-behaved API client —
 * Gmail's per-minute quota is per-user, so firing a whole query's worth of
 * messages.get calls at once (hundreds, for a broad year-long search) blows
 * through it in a single burst even though the daily/total budget is fine.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await withQuotaRetry(() => fn(items[i]));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const MAX_BACKOFF_MS = 30_000;

export async function withQuotaRetry<R>(fn: () => Promise<R>, maxAttempts = 8): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: number | string })?.code;
      const isQuotaError =
        String(code) === "429" || // googleapis-common's GaxiosError.code is a string, not a number
        /quota exceeded/i.test((e as Error)?.message ?? "");
      if (!isQuotaError || attempt >= maxAttempts) throw e;
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS); // 1s, 2s, 4s... capped at 30s
      logger.debug(`Gmail quota hit, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Pull enough of a message to identify what it is, without the full body (which is mostly tracking-link bloat in marketing/notification email). */
async function getSummary(
  client: gmail_v1.Gmail,
  messageId: string,
  threadId: string,
  matchedQuery: string
): Promise<EmailSummary | null> {
  const res = await client.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"],
  });
  const headers = res.data.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  const internalDate = res.data.internalDate;
  if (!internalDate) return null;
  return {
    messageId,
    threadId,
    date: new Date(Number(internalDate)).toISOString(),
    from: header("From"),
    subject: header("Subject"),
    snippet: res.data.snippet ?? "",
    matchedQuery,
  };
}

/**
 * Run the fixed query set against a single year and return a deduplicated,
 * chronologically sorted list of email summaries. Deterministic data fetch
 * only — no judgment about which of these are actually trips; that's
 * catalog-trip-year.md's job.
 */
export async function searchTravelEmailsForYear(
  year: number,
  {
    maxResultsPerQuery = 100,
    concurrency = 2,
    pauseBetweenQueriesMs = 3000,
  }: { maxResultsPerQuery?: number; concurrency?: number; pauseBetweenQueriesMs?: number } = {}
): Promise<EmailSummary[]> {
  const auth = getAuthorizedClient();
  const client = gmail({ version: "v1", auth });
  const { after, before } = dateRangeForYear(year);

  const seen = new Map<string, EmailSummary>();

  for (const { name, query } of QUERY_TEMPLATES) {
    const fullQuery = `${query} after:${after} before:${before}`;
    logger.debug(`[${name}] ${fullQuery}`);
    try {
      const listRes = await withQuotaRetry(() =>
        client.users.messages.list({ userId: "me", q: fullQuery, maxResults: maxResultsPerQuery })
      );
      const messages = listRes.data.messages ?? [];
      const summaries = await mapWithConcurrency(messages, concurrency, (m) =>
        getSummary(client, m.id!, m.threadId!, name)
      );
      for (const s of summaries) {
        if (s && !seen.has(s.messageId)) seen.set(s.messageId, s);
      }
    } catch (e) {
      // One query exhausting its retries shouldn't sink the whole fetch —
      // this is a best-effort deterministic pass; a partial result (and a
      // loud warning) beats catalog-trip-year.md getting no context at all.
      logger.warn(`Gmail query "${name}" failed after retries, skipping it: ${e}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pauseBetweenQueriesMs));
  }

  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}
