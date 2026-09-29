import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../../../core/config";

/**
 * Reads the Google Maps Timeline export (a manual, occasionally-refreshed JSON
 * dump — not an API) and turns it into candidate "away from home" trip
 * clusters for a given year. This is the deterministic half of trip
 * cataloging: figuring out *when and roughly where* you were away. Matching
 * those clusters up to actual trips (what the trip was, who with, flights,
 * hotels, restaurants) requires Gmail, which this harness doesn't have wired
 * up — that's the skill's job when run somewhere with Gmail access.
 */

interface RawTimelineEntry {
  startTime: string;
  endTime: string;
  visit?: {
    topCandidate?: {
      placeID?: string;
      placeLocation?: string; // "geo:LAT,LNG"
    };
  };
}

export interface TimelineVisit {
  date: string; // YYYY-MM-DD, local
  localTimeRange: string; // "HH:MM–HH:MM"
  durationMinutes: number;
  lat: number;
  lng: number;
  placeId: string;
  mapUrl: string;
}

export interface TimelineCluster {
  startDate: string;
  endDate: string;
  visits: TimelineVisit[];
}

export interface TimelineContext {
  year: number;
  datasetCoversFrom: string | null;
  datasetCoversTo: string | null;
  hasCoverageForYear: boolean;
  routinePlaceIds: string[];
  clusters: TimelineCluster[];
}

/** Gap between consecutive away-from-home visits big enough to call them separate trips. */
const TRIP_GAP_HOURS = 30;

/**
 * A place visited on at least this many distinct days across the whole export
 * is routine (home, work, gym, a partner's place...), not a trip destination —
 * even a real recurring getaway (a family cabin) is visited on far fewer
 * distinct days per year than daily life is. Excluding just the single
 * top place by dwell time isn't enough: home and a second routine place
 * (observed in practice) both dwarf everywhere else and, left in, merge
 * months of ordinary life into one giant false "trip".
 */
const ROUTINE_DISTINCT_DAYS_THRESHOLD = 8;

function timelinePath(): string {
  return path.join(getConfig().getBrainRoot(), "travel", "Timeline.json");
}

function parseGeo(placeLocation: string | undefined): { lat: number; lng: number } | null {
  if (!placeLocation) return null;
  const m = placeLocation.match(/^geo:(-?\d+\.?\d*),(-?\d+\.?\d*)$/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
}

/** Local date (YYYY-MM-DD) and time (HH:MM:SS) straight from the ISO string's own UTC offset — no timezone math needed. */
function localDateTime(iso: string): { date: string; time: string } {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}/);
  if (!m) throw new Error(`Unparseable timeline timestamp: ${iso}`);
  return { date: m[1], time: m[2] };
}

function mapUrl(lat: number, lng: number, placeId: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${placeId}`;
}

function loadVisits(): Array<RawTimelineEntry & { placeId: string; lat: number; lng: number }> {
  const filePath = timelinePath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Timeline export not found at ${filePath} — see node/README.md for where this lives.`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawTimelineEntry[];
  const visits: Array<RawTimelineEntry & { placeId: string; lat: number; lng: number }> = [];
  for (const entry of raw) {
    const candidate = entry.visit?.topCandidate;
    const placeId = candidate?.placeID;
    const geo = parseGeo(candidate?.placeLocation);
    if (!placeId || !geo) continue; // skip "activity" (transit) legs and unresolved visits
    visits.push({ ...entry, placeId, lat: geo.lat, lng: geo.lng });
  }
  return visits;
}

/** Places visited often enough across the whole export to be routine life, not trip destinations. */
function findRoutinePlaceIds(visits: Array<{ placeId: string; startTime: string }>): Set<string> {
  const distinctDays = new Map<string, Set<string>>();
  for (const v of visits) {
    const { date } = localDateTime(v.startTime);
    if (!distinctDays.has(v.placeId)) distinctDays.set(v.placeId, new Set());
    distinctDays.get(v.placeId)!.add(date);
  }
  const routine = new Set<string>();
  for (const [placeId, days] of distinctDays) {
    if (days.size >= ROUTINE_DISTINCT_DAYS_THRESHOLD) routine.add(placeId);
  }
  return routine;
}

/** Filter to a year's away-from-home visits and group into trip-shaped clusters by time gap. */
export function timelineForYear(year: number): TimelineContext {
  const allVisits = loadVisits();

  const datasetCoversFrom = allVisits.length
    ? allVisits.reduce((min, v) => (v.startTime < min ? v.startTime : min), allVisits[0].startTime)
    : null;
  const datasetCoversTo = allVisits.length
    ? allVisits.reduce((max, v) => (v.endTime > max ? v.endTime : max), allVisits[0].endTime)
    : null;

  const routinePlaceIds = findRoutinePlaceIds(allVisits);

  const yearVisits = allVisits
    .filter((v) => localDateTime(v.startTime).date.startsWith(`${year}-`))
    .filter((v) => !routinePlaceIds.has(v.placeId))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const hasCoverageForYear =
    datasetCoversFrom !== null && datasetCoversTo !== null && `${year}-12-31` >= datasetCoversFrom.slice(0, 10) && `${year}-01-01` <= datasetCoversTo.slice(0, 10);

  const clusters: TimelineCluster[] = [];
  let current: TimelineVisit[] = [];
  let prevEndMs: number | null = null;

  const flush = () => {
    if (current.length === 0) return;
    clusters.push({
      startDate: current[0].date,
      endDate: current[current.length - 1].date,
      visits: current,
    });
    current = [];
  };

  for (const v of yearVisits) {
    const startMs = new Date(v.startTime).getTime();
    const endMs = new Date(v.endTime).getTime();
    const { date, time: startTime } = localDateTime(v.startTime);
    const { time: endTime } = localDateTime(v.endTime);
    const durationMinutes = Math.round((endMs - startMs) / 60000);

    if (prevEndMs !== null && (startMs - prevEndMs) / 3600000 > TRIP_GAP_HOURS) {
      flush();
    }

    current.push({
      date,
      localTimeRange: `${startTime.slice(0, 5)}–${endTime.slice(0, 5)}`,
      durationMinutes,
      lat: v.lat,
      lng: v.lng,
      placeId: v.placeId,
      mapUrl: mapUrl(v.lat, v.lng, v.placeId),
    });
    prevEndMs = endMs;
  }
  flush();

  return {
    year,
    datasetCoversFrom,
    datasetCoversTo,
    hasCoverageForYear,
    routinePlaceIds: [...routinePlaceIds],
    clusters,
  };
}
