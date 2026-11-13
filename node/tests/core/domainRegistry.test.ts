import * as path from "path";
import {
  getDomainConfig,
  getDomainScriptsDir,
  listAllDomainScripts,
  listDomainScripts,
  listRegisteredDomains,
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
});
