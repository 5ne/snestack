import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseMultiFileOutput, writeStagedCatalogFiles, writeCatalogFilesToDir } from "../../../../src/domains/travel/tools/fileWriter";

describe("parseMultiFileOutput", () => {
  it("splits a single response into named files", () => {
    const output = [
      "### FILE: 2024-08-canadian-rockies.md",
      "# Canadian Rockies",
      "body line",
      "### FILE: 00-index-2024.md",
      "# Trip Catalog — 2024",
      "index body",
    ].join("\n");

    const files = parseMultiFileOutput(output);

    expect(Object.keys(files)).toEqual(["2024-08-canadian-rockies.md", "00-index-2024.md"]);
    expect(files["2024-08-canadian-rockies.md"]).toBe("# Canadian Rockies\nbody line\n");
    expect(files["00-index-2024.md"]).toBe("# Trip Catalog — 2024\nindex body\n");
  });

  it("drops any preamble before the first marker", () => {
    const output = ["Sure, here are the files:", "", "### FILE: a.md", "content"].join("\n");
    const files = parseMultiFileOutput(output);
    expect(Object.keys(files)).toEqual(["a.md"]);
    expect(files["a.md"]).toBe("content\n");
  });

  it("returns an empty object when there are no markers at all", () => {
    expect(parseMultiFileOutput("just some prose, no files")).toEqual({});
  });
});

describe("writeStagedCatalogFiles", () => {
  let brainRoot: string;

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-travel-filewriter-test-"));
  });

  afterEach(() => {
    fs.rmSync(brainRoot, { recursive: true, force: true });
  });

  it("writes files under travel/<year>/.nightly-draft/", () => {
    const written = writeStagedCatalogFiles(brainRoot, 2024, { "a.md": "hello" });
    const expectedDir = path.join(brainRoot, "travel", "2024", ".nightly-draft");
    expect(written).toEqual([path.join(expectedDir, "a.md")]);
    expect(fs.readFileSync(path.join(expectedDir, "a.md"), "utf8")).toBe("hello");
  });

  it("clears stale files from a previous run before writing", () => {
    writeStagedCatalogFiles(brainRoot, 2024, { "old.md": "stale" });
    const written = writeStagedCatalogFiles(brainRoot, 2024, { "new.md": "fresh" });
    const dir = path.join(brainRoot, "travel", "2024", ".nightly-draft");
    expect(fs.readdirSync(dir)).toEqual(["new.md"]);
    expect(written).toEqual([path.join(dir, "new.md")]);
  });

  it("never touches the canonical year directory itself", () => {
    writeStagedCatalogFiles(brainRoot, 2024, { "a.md": "hello" });
    const canonicalFiles = fs
      .readdirSync(path.join(brainRoot, "travel", "2024"))
      .filter((f) => f !== ".nightly-draft");
    expect(canonicalFiles).toEqual([]);
  });
});

describe("writeCatalogFilesToDir", () => {
  it("writes the files into the given directory and clears stale contents first", () => {
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-outdir-"));
    fs.writeFileSync(path.join(dir, "stale.md"), "old");
    const written = writeCatalogFilesToDir(path.join(dir, "draft"), { "a.md": "A\n" });
    fs.writeFileSync(path.join(dir, "draft", "stale2.md"), "old");
    writeCatalogFilesToDir(path.join(dir, "draft"), { "b.md": "B\n" });
    expect(written).toEqual([path.join(dir, "draft", "a.md")]);
    expect(fs.readdirSync(path.join(dir, "draft"))).toEqual(["b.md"]);
    expect(fs.existsSync(path.join(dir, "stale.md"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
