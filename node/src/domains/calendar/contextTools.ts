import type { ContextToolMap } from "../../core/contextTools";
import { listEvents } from "./tools/calendarClient";

/**
 * The calendar domain's contextTools. Unlike the financial domain (where
 * `subject` is a ticker), here `subject` is a date scope: "today", "upcoming"
 * (rolling 7-day window), or an ISO date (YYYY-MM-DD) for that specific day.
 */
export const contextTools: ContextToolMap = {
  events: async (subject) => {
    const { timeMin, timeMax } = resolveWindow(subject);
    return listEvents(timeMin, timeMax);
  },
};

function resolveWindow(subject: string): { timeMin: string; timeMax: string } {
  const now = new Date();

  if (subject === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { timeMin: start.toISOString(), timeMax: end.toISOString() };
  }

  if (subject === "upcoming") {
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    return { timeMin: now.toISOString(), timeMax: end.toISOString() };
  }

  // Otherwise treat subject as an ISO date (YYYY-MM-DD) for that whole day.
  const start = new Date(`${subject}T00:00:00`);
  const end = new Date(`${subject}T23:59:59`);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}
