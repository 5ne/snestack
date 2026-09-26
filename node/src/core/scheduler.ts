import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import prompts from "prompts";

class SchedulerCancelled extends Error {}

/**
 * Guide the user through setting up a daily cron job for batch analysis.
 * Mirrors the Python implementation's setup_cron_interactive.
 *
 * The installed job runs the compiled CLI (`node dist/cli.js batch`), so
 * `npm run build` must be run first (and after any future code changes).
 */
export async function setupCronInteractive(): Promise<boolean> {
  console.log("\n" + "=".repeat(60));
  console.log("snestack Cron Scheduler Setup");
  console.log("=".repeat(60));
  console.log("\nThis will add a daily cron job to run snestack batch analysis.");
  console.log("You'll be able to choose the time.\n");

  const workDir = process.cwd();
  const nodePath = process.execPath;
  const distCli = path.join(workDir, "dist", "cli.js");

  if (!fs.existsSync(distCli)) {
    console.log("✗ dist/cli.js not found");
    console.log("  Run `npm run build` first, then re-run `snestack scheduler --setup`");
    return false;
  }

  try {
    console.log("What time should analysis run? (24-hour format)");
    const { hour } = await prompts(
      {
        type: "number",
        name: "hour",
        message: "  Hour (0-23)",
        initial: 6,
        min: 0,
        max: 23,
      },
      {
        onCancel: () => {
          throw new SchedulerCancelled();
        },
      }
    );
    const { minute } = await prompts(
      {
        type: "number",
        name: "minute",
        message: "  Minute (0-59)",
        initial: 0,
        min: 0,
        max: 59,
      },
      {
        onCancel: () => {
          throw new SchedulerCancelled();
        },
      }
    );

    const cronCmd = `${minute} ${hour} * * * cd ${workDir} && ${nodePath} ${distCli} batch >> logs/snestack.cron.log 2>&1`;

    console.log(`\n${"=".repeat(60)}`);
    console.log("Cron Job Preview");
    console.log("=".repeat(60));
    console.log(`Time:    ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} daily`);
    console.log(`Command: ${cronCmd}`);
    console.log("=".repeat(60));

    const { confirmInstall } = await prompts(
      {
        type: "confirm",
        name: "confirmInstall",
        message: "\nAdd this cron job?",
        initial: false,
      },
      {
        onCancel: () => {
          throw new SchedulerCancelled();
        },
      }
    );
    if (!confirmInstall) {
      console.log("Setup cancelled.");
      return false;
    }

    return installCronJob(cronCmd, workDir);
  } catch (e) {
    if (e instanceof SchedulerCancelled) {
      console.log("\n\nSetup cancelled by user.");
      return false;
    }
    console.log(`✗ Scheduler setup failed: ${e}`);
    return false;
  }
}

function installCronJob(cronCmd: string, workDir: string): boolean {
  try {
    let currentCrontab = "";
    try {
      currentCrontab = execSync("crontab -l", { encoding: "utf8" });
    } catch {
      // No crontab installed yet — treat as empty.
      currentCrontab = "";
    }

    if (currentCrontab.includes(cronCmd)) {
      console.log("ℹ Cron job already installed");
      return true;
    }

    const newCrontab = currentCrontab + `\n# snestack batch analysis\n${cronCmd}\n`;
    execSync("crontab -", { input: newCrontab });

    console.log("\n✓ Cron job installed successfully!");
    console.log(`\nLogs saved to: ${path.join(workDir, "logs", "snestack.cron.log")}`);
    console.log("\nTo view installed crontab:");
    console.log("  crontab -l");
    console.log("\nTo remove snestack cron job:");
    console.log("  crontab -e  # then delete the snestack lines");
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.log("✗ crontab not found (not on Unix/Linux/macOS)");
      console.log("\nManual setup:");
      console.log("  1. Open your crontab editor:");
      console.log("     crontab -e");
      console.log("  2. Add this line:");
      console.log(`     ${cronCmd}`);
      console.log("  3. Save and exit");
      return false;
    }
    console.log(`✗ Cron install failed: ${err.message ?? err}`);
    return false;
  }
}

/** List installed crontab entries. Mirrors Python's list_cron_jobs. */
export function listCronJobs(): boolean {
  try {
    const out = execSync("crontab -l", { encoding: "utf8" });
    console.log("\n" + "=".repeat(60));
    console.log("Installed Crontab");
    console.log("=".repeat(60));
    console.log(out);
    console.log("=".repeat(60));
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.log("crontab not found (not on Unix/Linux/macOS)");
      return false;
    }
    console.log("No crontab installed");
    return false;
  }
}
