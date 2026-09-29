import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resetConfig } from "../../../../src/core/config";
import { timelineForYear } from "../../../../src/domains/travel/tools/timelineClient";

const SNESTACK_VARS = ["SNESTACK_BRAIN_ROOT"];

let brainRoot: string;

beforeEach(() => {
  resetConfig();
  SNESTACK_VARS.forEach((k) => delete process.env[k]);
  brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-travel-test-"));
  process.env.SNESTACK_BRAIN_ROOT = brainRoot;
  fs.mkdirSync(path.join(brainRoot, "travel"));
});

afterEach(() => {
  fs.rmSync(brainRoot, { recursive: true, force: true });
});

function writeTimeline(entries: unknown[]) {
  fs.writeFileSync(path.join(brainRoot, "travel", "Timeline.json"), JSON.stringify(entries));
}

function visit(startTime: string, endTime: string, placeId: string, lat: number, lng: number) {
  return {
    startTime,
    endTime,
    visit: {
      topCandidate: { placeID: placeId, placeLocation: `geo:${lat},${lng}` },
    },
  };
}

describe("timelineForYear", () => {
  it("throws a clear error when Timeline.json is missing", () => {
    expect(() => timelineForYear(2024)).toThrow(/Timeline export not found/);
  });

  it("reports no coverage for a year entirely outside the dataset", () => {
    writeTimeline([visit("2024-08-16T10:00:00-07:00", "2024-08-16T12:00:00-07:00", "trip-place", 37.0, -122.0)]);
    const ctx = timelineForYear(2023);
    expect(ctx.hasCoverageForYear).toBe(false);
    expect(ctx.clusters).toHaveLength(0);
  });

  it("excludes routine places (visited on 8+ distinct days) but keeps genuine trip visits", () => {
    const entries: unknown[] = [];
    // "home" visited daily for 10 days — should be excluded as routine.
    for (let day = 1; day <= 10; day++) {
      const d = String(day).padStart(2, "0");
      entries.push(visit(`2024-09-${d}T08:00:00-07:00`, `2024-09-${d}T20:00:00-07:00`, "home-place", 37.7749, -122.4194));
    }
    // A single 2-day trip to a place visited only twice — should survive.
    entries.push(visit("2024-09-15T09:00:00-07:00", "2024-09-15T18:00:00-07:00", "trip-place", 34.05, -118.24));
    entries.push(visit("2024-09-16T09:00:00-07:00", "2024-09-16T18:00:00-07:00", "trip-place", 34.05, -118.24));
    writeTimeline(entries);

    const ctx = timelineForYear(2024);

    expect(ctx.routinePlaceIds).toContain("home-place");
    expect(ctx.routinePlaceIds).not.toContain("trip-place");
    expect(ctx.clusters).toHaveLength(1);
    expect(ctx.clusters[0].visits).toHaveLength(2);
    expect(ctx.clusters[0].visits.every((v) => v.placeId === "trip-place")).toBe(true);
  });

  it("splits visits into separate clusters when the gap exceeds the trip threshold", () => {
    writeTimeline([
      visit("2024-05-01T09:00:00-07:00", "2024-05-01T18:00:00-07:00", "place-a", 1, 1),
      // >30h later — a different trip.
      visit("2024-05-10T09:00:00-07:00", "2024-05-10T18:00:00-07:00", "place-b", 2, 2),
    ]);
    const ctx = timelineForYear(2024);
    expect(ctx.clusters).toHaveLength(2);
  });

  it("builds a working map link with lat/lng and place id", () => {
    writeTimeline([visit("2024-05-01T09:00:00-07:00", "2024-05-01T18:00:00-07:00", "abc123", 37.5, -122.5)]);
    const ctx = timelineForYear(2024);
    expect(ctx.clusters[0].visits[0].mapUrl).toBe(
      "https://www.google.com/maps/search/?api=1&query=37.5,-122.5&query_place_id=abc123"
    );
  });
});
