import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import prompts from "prompts";
import {
  archiveReport,
  organizeReports,
  extractTickerFromText,
  organizeReport,
  organizeStagedReports,
} from "../../../../src/domains/financial/tools/reportOrganizer";

describe("archiveReport", () => {
  let tmpDir: string;
  let archiveDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-organizer-"));
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-organize-"));
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

describe("extractTickerFromText", () => {
  it("returns null for empty text", () => {
    expect(extractTickerFromText("")).toBeNull();
  });

  it("returns null when there are no candidates", () => {
    expect(extractTickerFromText("just some prose with no tickers")).toBeNull();
  });

  it("extracts from the star-rating pattern", () => {
    expect(extractTickerFromText("NVIDIA Corp NVDA QQQQ Large Growth")).toBe("NVDA");
  });

  it("extracts from a parenthesized ticker", () => {
    expect(extractTickerFromText("Alphabet Inc (GOOG) is a holding company")).toBe("GOOG");
  });

  it("extracts from a 'Ticker:' label", () => {
    expect(extractTickerFromText("Report for Ticker: MSFT dated today")).toBe("MSFT");
  });

  it("extracts from a 'Symbol:' label", () => {
    expect(extractTickerFromText("Symbol: AAPL trading update")).toBe("AAPL");
  });

  it("excludes common currency codes", () => {
    expect(extractTickerFromText("Market Cap 5.42 USD (Tril)")).toBeNull();
  });
});

describe("organizeReport", () => {
  let tmpDir: string;
  let targetDir: string;
  let archiveDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-staging-"));
    targetDir = path.join(tmpDir, "target");
    archiveDir = path.join(tmpDir, "archive");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("falls back to a manual prompt when extraction fails, then files the report", async () => {
    const pdfPath = path.join(tmpDir, "unknown.pdf");
    fs.writeFileSync(pdfPath, "not a real pdf");

    prompts.inject(["msft"]);
    const ticker = await organizeReport(pdfPath, targetDir, archiveDir);

    expect(ticker).toBe("MSFT");
    expect(fs.existsSync(path.join(targetDir, "MSFT-morningstar.pdf"))).toBe(true);
    expect(fs.existsSync(pdfPath)).toBe(false); // removed from staging
    const archived = fs.readdirSync(archiveDir);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^MSFT-\d{8}-morningstar\.pdf$/);
  });

  it("skips the file when the user enters nothing", async () => {
    const pdfPath = path.join(tmpDir, "unknown2.pdf");
    fs.writeFileSync(pdfPath, "not a real pdf");

    prompts.inject([""]);
    const ticker = await organizeReport(pdfPath, targetDir, archiveDir);

    expect(ticker).toBeNull();
    expect(fs.existsSync(pdfPath)).toBe(true); // left in place
  });
});

describe("organizeStagedReports", () => {
  let tmpDir: string;
  let stagingDir: string;
  let targetDir: string;
  let archiveDir: string;
  let errorDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-staged-"));
    stagingDir = path.join(tmpDir, "staging");
    targetDir = path.join(tmpDir, "target");
    archiveDir = path.join(tmpDir, "archive");
    errorDir = path.join(tmpDir, "error");
    fs.mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty results when staging has no PDFs", async () => {
    const result = await organizeStagedReports(stagingDir, targetDir, archiveDir, errorDir);
    expect(result).toEqual({ success: [], failed: [] });
  });

  it("organizes multiple staged PDFs via manual entry", async () => {
    fs.writeFileSync(path.join(stagingDir, "a.pdf"), "not a real pdf");
    fs.writeFileSync(path.join(stagingDir, "b.pdf"), "not a real pdf");

    prompts.inject(["msft", "goog"]);
    const result = await organizeStagedReports(stagingDir, targetDir, archiveDir, errorDir);

    expect(result.success.sort()).toEqual(["GOOG", "MSFT"]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(path.join(targetDir, "MSFT-morningstar.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "GOOG-morningstar.pdf"))).toBe(true);
    expect(fs.readdirSync(stagingDir)).toHaveLength(0);
  });
});
