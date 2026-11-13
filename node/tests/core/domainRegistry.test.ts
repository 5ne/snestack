import * as path from "path";
import {
  getDomainConfig,
  getDomainScriptsDir,
  listAllDomainScripts,
  listDomainReferences,
  listDomainScripts,
  listDomainSkills,
  listRegisteredDomains,
  loadAllDomainApis,
  loadDomainSkillDetail,
} from "../../src/core/domainRegistry";

const nodeDir = path.resolve(__dirname, "../..");

describe("domainRegistry", () => {
  it("lists registered domains", () => {
    expect(listRegisteredDomains()).toEqual(expect.arrayContaining(["financial", "calendar", "travel"]));
  });

  it("throws on unknown domain", () => {
    expect(() => getDomainConfig("nonexistent")).toThrow(/Unknown domain/);
  });

  it("resolves registered scriptsDir and lists domain scripts", () => {
    expect(getDomainScriptsDir("calendar", nodeDir)).toBeNull();
    expect(listDomainScripts("calendar", nodeDir)).toEqual([]);

    expect(getDomainScriptsDir("financial", nodeDir)).toBe(path.join(nodeDir, "src/domains/financial/scripts"));
    expect(listDomainScripts("financial", nodeDir)).toEqual([
      "daily-analysis.sh",
      "data-refresh-daily.sh",
      "data-refresh-intraday.sh",
      "swing-check.sh",
    ]);

    expect(listAllDomainScripts(nodeDir)).toEqual({
      financial: [
        "daily-analysis.sh",
        "data-refresh-daily.sh",
        "data-refresh-intraday.sh",
        "swing-check.sh",
      ],
      calendar: [],
      travel: ["travel-catalog-backfill.sh", "travel-catalog-nightly.sh"],
    });
  });

  it("lists runnable domain skills, references, skill details, and domain API modules", async () => {
    const finSkills = listDomainSkills("financial", { nodeDir });
    expect(finSkills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["long-term-quality", "swing-trading-large-cap", "buffett-value"])
    );
    expect(finSkills.map((s) => s.name)).not.toContain("vision");
    expect(finSkills.map((s) => s.name)).not.toContain("INDEX");

    const allFinDocs = listDomainSkills("financial", { includeDocs: true, nodeDir });
    expect(allFinDocs.map((s) => s.name)).toEqual(expect.arrayContaining(["vision", "INDEX"]));

    expect(listDomainReferences("financial", nodeDir)).toEqual(
      expect.arrayContaining(["quality-bar", "buffett-playbook"])
    );

    const detail = loadDomainSkillDetail("financial", "long-term-quality", nodeDir);
    expect(detail.runnable).toBe(true);
    expect(detail.references["quality-bar"]).toContain("Quality");

    const apis = await loadAllDomainApis();
    expect(Object.keys(apis)).toEqual(["financial", "calendar", "travel"]);
    expect(apis.financial.routes.length).toBeGreaterThan(0);
  });
});
