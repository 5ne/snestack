import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import prompts from "prompts";

jest.mock("child_process", () => ({
  execSync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execSync } = require("child_process");
import { setupCronInteractive, listCronJobs } from "../../src/core/scheduler";

const mockedExecSync = execSync as jest.Mock;

describe("setupCronInteractive", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-scheduler-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    mockedExecSync.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("fails when dist/cli.js hasn't been built", async () => {
    const ok = await setupCronInteractive();
    expect(ok).toBe(false);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("installs a new cron job when confirmed", async () => {
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "cli.js"), "// stub");
    mockedExecSync.mockReturnValue("");

    prompts.inject([6, 0, true]); // hour, minute, confirmInstall
    const ok = await setupCronInteractive();
    expect(ok).toBe(true);
    expect(mockedExecSync).toHaveBeenCalledWith(
      "crontab -",
      expect.objectContaining({ input: expect.stringContaining("snestack batch analysis") })
    );
  });

  it("does not install when the user declines", async () => {
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "cli.js"), "// stub");
    mockedExecSync.mockReturnValue("");

    prompts.inject([6, 0, false]);
    const ok = await setupCronInteractive();
    expect(ok).toBe(false);
    expect(mockedExecSync).not.toHaveBeenCalledWith("crontab -", expect.anything());
  });

  it("does not reinstall a job that's already present", async () => {
    fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "cli.js"), "// stub");

    const distCli = path.join(tmpDir, "dist", "cli.js");
    const existingCmd = `0 6 * * * cd ${tmpDir} && ${process.execPath} ${distCli} batch >> logs/snestack.cron.log 2>&1`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "crontab -l") return `${existingCmd}\n`;
      return "";
    });

    prompts.inject([6, 0, true]);
    const ok = await setupCronInteractive();
    expect(ok).toBe(true);
    expect(mockedExecSync).not.toHaveBeenCalledWith("crontab -", expect.anything());
  });
});

describe("listCronJobs", () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
  });

  it("returns true and prints the crontab when one exists", () => {
    mockedExecSync.mockReturnValue("0 6 * * * echo hi\n");
    expect(listCronJobs()).toBe(true);
  });

  it("returns false when no crontab is installed", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("no crontab for user");
    });
    expect(listCronJobs()).toBe(false);
  });
});
