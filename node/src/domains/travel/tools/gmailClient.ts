import { gmail, gmail_v1 } from "@googleapis/gmail";
import { getAuthorizedClient } from "../googleAuth";
import { getLogger } from "../../../core/logger";
import { htmlToPlainText, truncate } from "./htmlToPlainText";

const logger = getLogger("GmailClient");

export interface EmailSummary {
  messageId: string;
  threadId: string;
  date: string; // ISO timestamp, from the message's internalDate
  from: string;
  subject: string;
  snippet: string;
  matchedQuery: string;
  /**
   * Full plaintext body (HTML stripped, long tracking-link tokens collapsed,
   * length-capped) — present only for messages selected as candidates (see
   * selectFullBodyCandidates): one per thread, from the evidence-bearing
   * categories, with marketing/loyalty/survey subjects filtered out. Most
   * summaries won't have this; the snippet is all there is for them, same as
   * before.
   */
  fullBody?: string;
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
 * Run `items` through `fn` at most `concurrency` at a time. Pure concurrency
 * limiting only — callers decide their own retry behavior (see
 * withQuotaRetry) by wrapping `fn` themselves; keeping the two concerns
 * separate means a caller that wants to catch a permanent per-item failure
 * (rather than let it abort the whole batch) can do so around the retry,
 * not instead of it. Caps concurrency because Gmail's per-minute quota is
 * per-user: firing a whole query's worth of messages.get calls at once
 * (hundreds, for a broad year-long search) blows through it in a single
 * burst even though the daily/total budget is fine.
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
      results[i] = await fn(items[i]);
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
 * Categories worth a deeper fetch — the ones that actually carry the
 * structured details (flight numbers, confirmation codes, nightly rates,
 * merchant names) that a 150-character snippet truncates. "rideshare" and
 * "cancellations" skipped: receipts there rarely add much beyond the
 * snippet, and cancellations are usually confirmed by the matching booking
 * email already being a candidate.
 */
const FULL_BODY_CATEGORIES = new Set(["flights", "hotels", "car-rentals", "dining", "foreign-transactions"]);

/**
 * Subjects shaped like loyalty-program/marketing/survey email rather than an
 * actual booking confirmation — these are both low-value (nothing a trip
 * needs lives in them) and the worst offenders for tracking-link bloat, so
 * excluding them from the full-body fetch cuts cost on exactly the emails
 * least likely to be worth it.
 */
const NOISE_SUBJECT_PATTERN =
  /(statement|esummary|e-summary|summary|deal|offer|sale|newsletter|survey|digest|tell us how we did|wi-?fi and entertainment|economy plus availability|bonus miles|miles balance|anniversary|advantage program|mileageplus|feedback)/i;

const MAX_FULL_BODY_FETCHES = 60;
const FULL_BODY_MAX_CHARS = 3000;

/**
 * Deterministically pick which already-fetched summaries are worth a full
 * body fetch: evidence-bearing category, not marketing-shaped, one
 * representative per thread (a confirmation thread often has several
 * near-identical copies), capped so a dense year doesn't balloon the fetch.
 */
export function selectFullBodyCandidates(summaries: EmailSummary[]): EmailSummary[] {
  const seenThreads = new Set<string>();
  const candidates: EmailSummary[] = [];
  for (const s of summaries) {
    if (!FULL_BODY_CATEGORIES.has(s.matchedQuery)) continue;
    if (NOISE_SUBJECT_PATTERN.test(s.subject)) continue;
    if (seenThreads.has(s.threadId)) continue;
    seenThreads.add(s.threadId);
    candidates.push(s);
    if (candidates.length >= MAX_FULL_BODY_FETCHES) break;
  }
  return candidates;
}

/** Depth-first search for the first MIME part of the given type, preferring text/plain over text/html at the call site. */
function findPart(
  parts: gmail_v1.Schema$MessagePart[] | undefined,
  mimeType: string
): gmail_v1.Schema$MessagePart | null {
  for (const part of parts ?? []) {
    if (part.mimeType === mimeType && part.body?.data) return part;
    const nested = findPart(part.parts, mimeType);
    if (nested) return nested;
  }
  return null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64").toString("utf8");
}

/** Extract body text from a full-format message payload, preferring text/plain, falling back to stripped text/html. */
function extractBodyText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if (payload.body?.data && payload.mimeType === "text/plain") {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.body?.data && payload.mimeType === "text/html") {
    return htmlToPlainText(decodeBase64Url(payload.body.data));
  }
  const plainPart = findPart(payload.parts, "text/plain");
  if (plainPart?.body?.data) return decodeBase64Url(plainPart.body.data);
  const htmlPart = findPart(payload.parts, "text/html");
  if (htmlPart?.body?.data) return htmlToPlainText(decodeBase64Url(htmlPart.body.data));
  return "";
}

async function fetchFullBody(client: gmail_v1.Gmail, messageId: string): Promise<string> {
  const res = await client.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return truncate(extractBodyText(res.data.payload).trim(), FULL_BODY_MAX_CHARS);
}

/**
 * Run the fixed query set against a single year and return a deduplicated,
 * chronologically sorted list of email summaries. Deterministic data fetch
 * only — no judgment about which of these are actually trips; that's
 * catalog-trip-year.md's job. A bounded second stage then fetches full
 * bodies for whichever of those summaries selectFullBodyCandidates picks.
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
        withQuotaRetry(() => getSummary(client, m.id!, m.threadId!, name))
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

  const allSummaries = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));

  const candidates = selectFullBodyCandidates(allSummaries);
  logger.debug(`Fetching full bodies for ${candidates.length} candidate message(s) of ${allSummaries.length} total`);
  await new Promise((resolve) => setTimeout(resolve, pauseBetweenQueriesMs));
  const bodies = await mapWithConcurrency(candidates, concurrency, async (c) => {
    try {
      return { messageId: c.messageId, body: await withQuotaRetry(() => fetchFullBody(client, c.messageId)) };
    } catch (e) {
      // Retries (inside withQuotaRetry) are already exhausted by the time we get here —
      // this is the "give up on just this one item" catch, not a substitute for retrying.
      logger.warn(`Full-body fetch failed for message ${c.messageId}, leaving it snippet-only: ${e}`);
      return { messageId: c.messageId, body: "" };
    }
  });
  const bodyByMessageId = new Map(bodies.map((b) => [b.messageId, b.body]));
  for (const s of allSummaries) {
    const body = bodyByMessageId.get(s.messageId);
    if (body) s.fullBody = body;
  }

  return allSummaries;
}
