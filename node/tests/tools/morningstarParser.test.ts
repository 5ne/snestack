import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findReport } from "../../src/tools/morningstarParser";

describe("findReport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fstack-reports-"));
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
    const { parseMorningstarPdf } = await import("../../src/tools/morningstarParser");
    const result = await parseMorningstarPdf("/nonexistent/NVDA-morningstar.pdf");
    expect(result).toEqual({});
  });

  it("returns empty object for invalid PDF", async () => {
    const { parseMorningstarPdf } = await import("../../src/tools/morningstarParser");
    const tmpFile = path.join(os.tmpdir(), `fstack-test-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, "this is not a pdf");
    const result = await parseMorningstarPdf(tmpFile);
    expect(result).toEqual({});
    fs.unlinkSync(tmpFile);
  });
});
