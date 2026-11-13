import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Cron execs these directly; a script without the executable bit fails before
// scripts/lib/run-log.sh runs, so nothing is logged and the only trace is a later
// `missing_run` in run-check. Scripts under scripts/lib/ are sourced, not exec'd.
const scriptsDir = path.resolve(__dirname, "../scripts");
const runLogSh = path.join(scriptsDir, "lib/run-log.sh");
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

describe("run-log.sh per-script lock", () => {
  it("skips an overlapping invocation of the same script and cleans up stale locks", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-lock-test-"));
    try {
      const env = { ...process.env, SNESTACK_STAGING_ROOT: tmpRoot };
      const pubDir = path.join(tmpRoot, "pub");

      // Start holder process that acquires lock, writes marker, and sleeps briefly.
      const holder = spawn(
        "bash",
        ["-c", `. "${runLogSh}"; rl_init test-script "${pubDir}"; echo ok > "$RUN_DIR/marker"; sleep 1`],
        { env }
      );

      // Wait until holder has written its pid file.
      const lockPidFile = path.join(tmpRoot, "locks", "test-script.lock", "pid");
      for (let i = 0; i < 40 && !fs.existsSync(lockPidFile); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fs.existsSync(lockPidFile)).toBe(true);

      // Overlapping invocation should exit 0 immediately with "Skipped:" on stderr and not touch marker.
      let stderr = "";
      try {
        execFileSync(
          "bash",
          ["-c", `. "${runLogSh}"; rl_init test-script "${pubDir}"; echo clobbered > "$RUN_DIR/marker"`],
          { env, stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch (e: unknown) {
        throw new Error(`Expected exit 0, got error: ${String(e)}`);
      }
      // Capture stderr from a second overlapping run to assert the skip message.
      const contender = spawn(
        "bash",
        ["-c", `. "${runLogSh}"; rl_init test-script "${pubDir}"`],
        { env }
      );
      contender.stderr.on("data", (d) => { stderr += String(d); });
      const contenderCode = await new Promise<number | null>((res) => contender.on("close", res));
      expect(contenderCode).toBe(0);
      expect(stderr).toContain("Skipped: test-script is already running");

      const holderCode = await new Promise<number | null>((res) => holder.on("close", res));
      expect(holderCode).toBe(0);
      expect(fs.readFileSync(path.join(tmpRoot, "runs", "test-script", "pub", "marker"), "utf8").trim()).toBe("ok");
      expect(fs.existsSync(path.join(tmpRoot, "locks", "test-script.lock"))).toBe(false);

      // Stale lock (dead PID) should be cleared automatically.
      const staleLockDir = path.join(tmpRoot, "locks", "test-script.lock");
      fs.mkdirSync(staleLockDir, { recursive: true });
      fs.writeFileSync(path.join(staleLockDir, "pid"), "999999\n");
      execFileSync(
        "bash",
        ["-c", `. "${runLogSh}"; rl_init test-script "${pubDir}"; echo recovered > "$RUN_DIR/marker"`],
        { env }
      );
      expect(fs.readFileSync(path.join(tmpRoot, "runs", "test-script", "pub", "marker"), "utf8").trim()).toBe("recovered");
      expect(fs.existsSync(staleLockDir)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
