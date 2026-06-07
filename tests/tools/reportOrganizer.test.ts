import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { archiveReport, organizeReports } from "../../src/tools/reportOrganizer";

describe("archiveReport", () => {
  let tmpDir: string;
  let archiveDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fstack-organizer-"));
    archiveDir = path.join(tmpDir, "archive");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("archives a report with date-stamped name", () => {
    const src = path.join(tmpDir, "NVDA-morningstar.pdf");
    fs.writeFileSync(src, "pdf content");
    const dest = archiveReport(src, archiveDir, "2024-01-15");
    expect(dest).not.toBeNull();
    expect(fs.existsSync(dest!)).toBe(true);
    expect(path.basename(dest!)).toBe("NVDA-morningstar-2024-01-15.pdf");
  });

  it("creates archive dir if it doesn't exist", () => {
    const src = path.join(tmpDir, "AAPL-morningstar.pdf");
    fs.writeFileSync(src, "pdf content");
    archiveReport(src, archiveDir, "2024-01-15");
    expect(fs.existsSync(archiveDir)).toBe(true);
  });

  it("returns null for non-existent source", () => {
    const dest = archiveReport("/nonexistent.pdf", archiveDir, "2024-01-15");
    expect(dest).toBeNull();
  });

  it("uses today's date when no date provided", () => {
    const src = path.join(tmpDir, "META-morningstar.pdf");
    fs.writeFileSync(src, "pdf content");
    const dest = archiveReport(src, archiveDir);
    expect(dest).not.toBeNull();
    const today = new Date().toISOString().split("T")[0];
    expect(dest!).toContain(today);
  });
});

describe("organizeReports", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fstack-organize-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty array for non-existent directory", () => {
    expect(organizeReports("/nonexistent")).toEqual([]);
  });

  it("returns empty array when no files to rename", () => {
    fs.writeFileSync(path.join(tmpDir, "NVDA-morningstar.pdf"), "pdf");
    expect(organizeReports(tmpDir)).toEqual([]);
  });

  it("skips already correctly named files", () => {
    fs.writeFileSync(path.join(tmpDir, "NVDA-morningstar.pdf"), "pdf");
    const renamed = organizeReports(tmpDir);
    expect(renamed).toHaveLength(0);
    // Original file still exists
    expect(fs.existsSync(path.join(tmpDir, "NVDA-morningstar.pdf"))).toBe(true);
  });
});
