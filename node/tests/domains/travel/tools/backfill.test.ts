import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  nextBackfillYear,
  isYearCataloged,
  BACKFILL_START_YEAR,
  BACKFILL_END_YEAR,
} from "../../../../src/domains/travel/tools/backfill";

describe("nextBackfillYear", () => {
  let travel: string;
  const touch = (...parts: string[]) => {
    const file = path.join(travel, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
  };

  beforeEach(() => {
    travel = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-travel-"));
  });
  afterEach(() => fs.rmSync(travel, { recursive: true, force: true }));

  it("starts at the start year when nothing is cataloged", () => {
    expect(nextBackfillYear(travel)).toBe(BACKFILL_START_YEAR);
  });

  it("treats a staged draft index as done, so the next night goes one year back", () => {
    touch("2019", ".nightly-draft", "00-index-2019.md");
    expect(isYearCataloged(travel, 2019)).toBe(true);
    expect(nextBackfillYear(travel)).toBe(2018);
  });

  it("treats a canonical index as done too", () => {
    touch("2019", "00-index-2019.md");
    touch("2018", ".nightly-draft", "00-index-2018.md");
    expect(nextBackfillYear(travel)).toBe(2017);
  });

  it("retries a year whose run wrote files but no index", () => {
    touch("2019", ".nightly-draft", "00-index-2019.md");
    touch("2018", ".nightly-draft", "2018-03-somewhere.md");
    expect(nextBackfillYear(travel)).toBe(2018);
  });

  it("returns null once every year down to the end year is done", () => {
    for (let y = BACKFILL_START_YEAR; y >= BACKFILL_END_YEAR; y--) touch(String(y), ".nightly-draft", `00-index-${y}.md`);
    expect(nextBackfillYear(travel)).toBeNull();
  });
});
