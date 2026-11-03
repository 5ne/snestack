import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Cron execs these directly; a script without the executable bit fails before
// scripts/lib/run-log.sh runs, so nothing is logged and the only trace is a later
// `missing_run` in run-check. Scripts under scripts/lib/ are sourced, not exec'd.
const scriptsDir = path.resolve(__dirname, "../scripts");
const cronScripts = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".sh")).sort();

describe("cron scripts", () => {
  it("finds the scripts to check", () => {
    expect(cronScripts).toEqual(expect.arrayContaining(["swing-check.sh", "daily-analysis.sh"]));
  });

  it.each(cronScripts)("%s is executable on disk", (name) => {
    expect(fs.statSync(path.join(scriptsDir, name)).mode & 0o111).not.toBe(0);
  });

  it.each(cronScripts)("%s is committed with mode 100755", (name) => {
    let staged: string;
    try {
      staged = execFileSync("git", ["ls-files", "-s", "--", name], { cwd: scriptsDir, encoding: "utf8" });
    } catch {
      return; // not a git checkout (e.g. an exported tarball)
    }
    if (!staged.trim()) return; // untracked
    expect(staged.split(" ")[0]).toBe("100755");
  });
});
