import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildBuffettResearchAreas,
  companyBrainPath,
  extractRecordedThesis,
  hasRecordedThesisFile,
  inspectTickerThesis,
  evaluateThesisCoverage,
  checkThesisCoverageFindings,
} from "../../../src/domains/financial/thesisCoverage";

describe("thesisCoverage", () => {
  let brainRoot: string;

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-thesis-coverage-"));
  });

  afterEach(() => {
    fs.rmSync(brainRoot, { recursive: true, force: true });
  });

  function writeCompanyFile(ticker: string, content: string): void {
    const p = companyBrainPath(brainRoot, ticker);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }

  describe("extractRecordedThesis", () => {
    it("extracts a real blockquoted thesis and ignores migrated-words footnote", () => {
      const md = [
        "---",
        "ticker: AAPL",
        "status: position",
        "---",
        "",
        "# AAPL",
        "",
        "## Status",
        "- Position: 442 shares",
        "",
        "## Your thesis (compiled truth)",
        "",
        '> "bought batches from 2020 to 2024 because of constant product growth"',
        "",
        "_(your own words, migrated from fstack.db positions.notes)_",
        "",
        "## History",
        "- **2026-06-02** — HOLD",
      ].join("\n");

      expect(extractRecordedThesis(md)).toBe("bought batches from 2020 to 2024 because of constant product growth");
    });

    it("treats even a single-word recorded thesis like DELL ('AI') as covered", () => {
      const md = [
        "# DELL",
        "## Your thesis (compiled truth)",
        '> "AI"',
        "_(your own words, migrated from fstack.db watchlist.thesis)_",
        "## History",
      ].join("\n");

      expect(extractRecordedThesis(md)).toBe("AI");
    });

    it("returns null for the blank template placeholder ('_No thesis recorded yet..._')", () => {
      const md = [
        "---",
        "ticker: GOOG",
        "status: position",
        "---",
        "",
        "# GOOG",
        "",
        "## Status",
        "- Position: 110 shares @ $89.99 cost basis",
        "",
        "## Your thesis (compiled truth)",
        "",
        "_No thesis recorded yet. Add one via the CLI (`position add`/`watchlist add` notes) or just tell Claude — it belongs here as a dated entry._",
        "",
        "## History",
        "- **2026-08-23** — BUY (72% confidence): ...",
      ].join("\n");

      expect(extractRecordedThesis(md)).toBeNull();
    });

    it("returns null when the thesis section is empty, comment-only, or absent", () => {
      expect(extractRecordedThesis("# SPCX\n\n## Status\n- Watchlist\n")).toBeNull();
      expect(
        extractRecordedThesis("# GOOG\n\n## Your thesis (compiled truth)\n\n<!-- fill me in -->\n\n## History\n")
      ).toBeNull();
      expect(extractRecordedThesis("# NFLX\n\n## Thesis\n\nTBD\n\n## History\n")).toBeNull();
    });
  });

  describe("evaluateThesisCoverage & checkThesisCoverageFindings", () => {
    it("separates covered, missing_file, and empty_thesis tickers deterministically", () => {
      writeCompanyFile(
        "AAPL",
        "# AAPL\n\n## Your thesis (compiled truth)\n\n> \"durable ecosystem\"\n\n## History\n"
      );
      writeCompanyFile(
        "GOOG",
        "# GOOG\n\n## Your thesis (compiled truth)\n\n_No thesis recorded yet. Add one via the CLI._\n\n## History\n"
      );
      writeCompanyFile("MSFT", "# MSFT\n\n## Your thesis (compiled truth)\n\n## History\n");

      const report = evaluateThesisCoverage(brainRoot, ["spcx", "goog", "aapl", "msft", "CRWD", "AAPL"]);
      expect(report.total).toBe(5);
      expect(report.covered).toEqual(["AAPL"]);
      expect(report.missingFile).toEqual(["CRWD", "SPCX"]);
      expect(report.emptyThesis).toEqual(["GOOG", "MSFT"]);
      expect(report.uncovered.map((u) => ({ ticker: u.ticker, status: u.status }))).toEqual([
        { ticker: "CRWD", status: "missing_file" },
        { ticker: "GOOG", status: "empty_thesis" },
        { ticker: "MSFT", status: "empty_thesis" },
        { ticker: "SPCX", status: "missing_file" },
      ]);
      // Covered tickers have no missing-thesis research areas; uncovered ones get all 5 Buffett pillars
      const aaplItem = report.items.find((i) => i.ticker === "AAPL")!;
      expect(aaplItem.researchAreas).toEqual([]);
      expect(hasRecordedThesisFile(aaplItem.filePath)).toBe(true);

      const googItem = inspectTickerThesis(brainRoot, "GOOG");
      expect(hasRecordedThesisFile(googItem.filePath)).toBe(false);
      expect(googItem.researchAreas.map((a) => a.area)).toEqual([
        "circle_of_competence",
        "economic_moat",
        "owner_earnings_and_fortress",
        "management_capital_allocation",
        "margin_of_safety_and_kill_criteria",
      ]);
      expect(googItem.researchAreas[0].whatBuffettWouldDo).toContain("GOOG's latest 10-K");
      expect(buildBuffettResearchAreas("crwd")).toHaveLength(5);
      expect(hasRecordedThesisFile(companyBrainPath(brainRoot, "CRWD"))).toBe(false);

      const findings = checkThesisCoverageFindings({
        now: new Date(2026, 10, 12, 12, 0, 0),
        brainRoot,
        tickers: ["SPCX", "GOOG", "AAPL", "MSFT", "CRWD"],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        severity: "warn",
        domain: "financial",
        date: "2026-11-12",
        code: "missing_thesis",
        message:
          "No recorded thesis for 4 of 5 tracked ticker(s) — missing brain file: CRWD, SPCX; empty thesis section: GOOG, MSFT (under financial/brain/investing/public/companies/). " +
          "Suggested Buffett research per uncovered ticker: 10-K business model & 10yr predictability, " +
          "economic moat & pricing power, 5yr owner earnings (FCF vs. GAAP) & debt payoff, " +
          "management capital allocation, and margin of safety.",
      });
    });

    it("emits no findings when every tracked ticker has a recorded thesis", () => {
      writeCompanyFile("NVDA", "# NVDA\n\n## Your thesis\n\nAI acceleration semiconductor.\n");
      const findings = checkThesisCoverageFindings({
        now: new Date(2026, 10, 12, 12, 0, 0),
        brainRoot,
        tickers: ["NVDA"],
      });
      expect(findings).toEqual([]);
    });

    it("skips silently when brainRoot does not exist (e.g. unmounted Drive)", () => {
      const missingRoot = path.join(brainRoot, "not-mounted");
      const findings = checkThesisCoverageFindings({
        now: new Date(2026, 10, 12, 12, 0, 0),
        brainRoot: missingRoot,
        tickers: ["AAPL", "GOOG"],
      });
      expect(findings).toEqual([]);
    });
  });
});
