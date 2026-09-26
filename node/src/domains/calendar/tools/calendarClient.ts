import { calendar, calendar_v3 } from "@googleapis/calendar";
import { getAuthorizedClient } from "../googleAuth";
import { getLogger } from "../../../core/logger";

const logger = getLogger("CalendarClient");

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null; // ISO datetime, or a plain date (YYYY-MM-DD) for all-day events
  end: string | null;
  location: string | null;
  attendees: string[];
}

function toCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: event.id ?? "",
    summary: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    location: event.location ?? null,
    attendees: (event.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
  };
}

/** List events on the primary calendar between two ISO timestamps. Read-only. */
export async function listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
  const auth = getAuthorizedClient();
  const client = calendar({ version: "v3", auth });
  logger.debug(`Listing events from ${timeMin} to ${timeMax}`);
  const res = await client.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return (res.data.items ?? []).map(toCalendarEvent);
}
