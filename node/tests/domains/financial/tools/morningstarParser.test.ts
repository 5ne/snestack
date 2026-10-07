import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findReport, extractFcfFromItems } from "../../../../src/domains/financial/tools/morningstarParser";

describe("findReport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-reports-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns path when report exists", () => {
    const pdfPath = path.join(tmpDir, "NVDA-morningstar.pdf");
    fs.writeFileSync(pdfPath, "fake pdf content");
    const found = findReport("NVDA", tmpDir);
    expect(found).toBe(pdfPath);
  });

  it("returns null when report does not exist", () => {
    const found = findReport("AAPL", tmpDir);
    expect(found).toBeNull();
  });

  it("is case-insensitive for ticker symbol", () => {
    const pdfPath = path.join(tmpDir, "NVDA-morningstar.pdf");
    fs.writeFileSync(pdfPath, "fake pdf content");
    expect(findReport("nvda", tmpDir)).toBe(pdfPath);
  });

  it("returns null for non-existent directory", () => {
    expect(findReport("NVDA", "/nonexistent/path")).toBeNull();
  });
});

describe("parseMorningstarPdf", () => {
  it("returns empty object for non-existent file", async () => {
    const { parseMorningstarPdf } = await import("../../../../src/domains/financial/tools/morningstarParser");
    const result = await parseMorningstarPdf("/nonexistent/NVDA-morningstar.pdf");
    expect(result).toEqual({});
  });

  it("returns empty object for invalid PDF", async () => {
    const { parseMorningstarPdf } = await import("../../../../src/domains/financial/tools/morningstarParser");
    const tmpFile = path.join(os.tmpdir(), `snestack-test-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, "this is not a pdf");
    const result = await parseMorningstarPdf(tmpFile);
    expect(result).toEqual({});
    fs.unlinkSync(tmpFile);
  });
});

describe("extractFcfFromItems", () => {
  // Mirrors a real report page: label split across items, 8 value cells, and a
  // year header whose right edges line up with the value columns.
  const label = (x: number, s: string) => ({ page: 13, x, y: 531, w: 15, s });
  const cell = (x: number, s: string) => ({ page: 13, x, y: 531, w: 17, s });
  const year = (x: number, s: string) => ({ page: 13, x, y: 627, w: 17, s });
  const row = [
    label(54, "Free "), label(68, "Cash "), label(84, "Flow "), label(99, "To   The    Firm "),
    label(135, "(USD "), label(151, "Mil)"),
    cell(282, "-7,138 "), cell(318, "-5,593 "), cell(354, "-4,203 "), cell(389, "-4,293 "),
    cell(425, "-3,544 "), cell(461, "-2,867 "), cell(497, "-2,037 "), cell(533, "-196"),
  ];
  const header = [year(282, "2023"), year(318, "2024"), year(354, "2025"), year(389, "2026")];

  it("takes the third column (latest actual year) in dollars, keeping the sign", () => {
    expect(extractFcfFromItems([...header, ...row])).toEqual({ fcf: -4203 * 1e6, fiscalYear: 2025 });
  });

  it("returns the value with a null year when no header lines up", () => {
    expect(extractFcfFromItems(row)).toEqual({ fcf: -4203 * 1e6, fiscalYear: null });
  });

  it("honors a billions unit (mega-caps are reported in whole $B)", () => {
    const bil = row.map((i) => (i.s === "Mil)" ? { ...i, s: "Bil)" } : i));
    expect(extractFcfFromItems([...header, ...bil])).toEqual({ fcf: -4203 * 1e9, fiscalYear: 2025 });
  });

  it("returns null when the FCF row is absent or has too few values", () => {
    expect(extractFcfFromItems(header)).toBeNull();
    expect(extractFcfFromItems(row.slice(0, 8))).toBeNull();
  });
});
