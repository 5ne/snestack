import * as fs from "fs";
import * as path from "path";

const FILE_MARKER = /^### FILE: (.+)$/;

/**
 * Split a single model response into named files, per the `### FILE: <name>`
 * delimiter convention catalog-trip-year.md's Output section asks the model
 * to use (the same convention distill-signals reads on the way in). Purely
 * mechanical string splitting — no judgment.
 */
export function parseMultiFileOutput(output: string): Record<string, string> {
  const files: Record<string, string> = {};
  let currentName: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentName) files[currentName] = currentLines.join("\n").trim() + "\n";
    currentLines = [];
  };

  for (const line of output.split("\n")) {
    const match = line.match(FILE_MARKER);
    if (match) {
      flush();
      currentName = match[1].trim();
    } else if (currentName) {
      currentLines.push(line);
    }
    // Lines before the first "### FILE:" marker (stray preamble) are dropped.
  }
  flush();

  return files;
}

/**
 * Write a set of named files under <brainRoot>/travel/<year>/<stagingDirName>/.
 * Deliberately writes to a staging subdirectory rather than overwriting the
 * year's canonical files directly: this skill's automated output (Gmail
 * snippets only, one non-interactive model pass, no follow-up searches) is
 * lower-fidelity than a manual run in a Claude Code session with full Gmail
 * access, so it shouldn't silently clobber hand-refined catalog files.
 * Returns the absolute paths written.
 */
export function writeStagedCatalogFiles(
  brainRoot: string,
  year: number,
  files: Record<string, string>,
  stagingDirName = ".nightly-draft"
): string[] {
  return writeCatalogFilesToDir(path.join(brainRoot, "travel", String(year), stagingDirName), files);
}

/** Write named files into `dir` (created if needed), clearing its previous contents first. Returns the paths written. */
export function writeCatalogFilesToDir(dir: string, files: Record<string, string>): string[] {
  fs.mkdirSync(dir, { recursive: true });

  // Clear previous draft contents first so a run that produces fewer files
  // than last time doesn't leave stale ones behind.
  for (const existing of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, existing), { recursive: true, force: true });
  }

  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.writeFileSync(target, content, "utf8");
    written.push(target);
  }
  return written;
}
