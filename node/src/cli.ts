#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import prompts from "prompts";
import { getConfig } from "./core/config";
import { setupInteractive, validateEnv } from "./core/setup";
import { ConfigError } from "./core/errors";
import { setupCronInteractive, listCronJobs } from "./scheduler";
import { organizeStagedReports } from "./tools/reportOrganizer";
import { Db } from "./core/db";
import { AnalysisOrchestrator } from "./orchestrator";

const program = new Command();

program
  .name("fstack")
  .description("Personal investment decision-support system")
  .version("1.0.0");

// ── Setup ──────────────────────────────────────────────────────────────────

program
  .command("setup")
  .description("Interactive setup for API keys and notifications")
  .option("--env-file <path>", "Path to .env file (default: .env)")
  .action(async (opts: { envFile?: string }) => {
    const ok = await setupInteractive(opts.envFile);
    if (!ok) process.exitCode = 1;
  });

// ── Position management ────────────────────────────────────────────────────

const position = program.command("position").description("Manage portfolio positions");

position
  .command("add <ticker> <shares> <cost_basis>")
  .description("Add or update a portfolio position")
  .option("-n, --notes <notes>", "Position notes")
  .action((ticker: string, sharesStr: string, costBasisStr: string, opts: { notes?: string }) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    const shares = parseFloat(sharesStr);
    const costBasis = parseFloat(costBasisStr);
    if (isNaN(shares) || isNaN(costBasis)) {
      console.error("shares and cost_basis must be numbers");
      process.exit(1);
    }
    // Ensure ticker exists in tickers table
    db.addTicker(ticker.toUpperCase(), ticker.toUpperCase(), "PUBLIC");
    const ok = db.addPosition(ticker.toUpperCase(), shares, costBasis, opts.notes);
    console.log(ok ? `Position added: ${ticker.toUpperCase()}` : "Failed to add position");
    db.close();
  });

position
  .command("remove <ticker>")
  .description("Remove a portfolio position")
  .action((ticker: string) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    const ok = db.removePosition(ticker.toUpperCase());
    console.log(ok ? `Position removed: ${ticker.toUpperCase()}` : "Position not found");
    db.close();
  });

position
  .command("list")
  .description("List all positions")
  .action(() => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    const positions = db.getAllPositions();
    if (positions.length === 0) {
      console.log("No positions");
    } else {
      console.log("\nPositions:");
      console.log("-".repeat(60));
      positions.forEach((p) => {
        console.log(`  ${p.ticker.padEnd(8)} ${p.shares} shares @ $${p.cost_basis.toFixed(2)}`);
        if (p.notes) console.log(`           ${p.notes}`);
      });
    }
    db.close();
  });

// ── Watchlist management ───────────────────────────────────────────────────

const watchlist = program.command("watchlist").description("Manage watchlist");

watchlist
  .command("add <ticker> <thesis>")
  .description("Add ticker to watchlist")
  .option("-n, --notes <notes>", "Additional notes")
  .action((ticker: string, thesis: string, opts: { notes?: string }) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    db.addTicker(ticker.toUpperCase(), ticker.toUpperCase(), "PUBLIC");
    const ok = db.addWatchlist(ticker.toUpperCase(), thesis, opts.notes);
    console.log(ok ? `Watchlist added: ${ticker.toUpperCase()}` : "Failed to add watchlist item");
    db.close();
  });

watchlist
  .command("remove <ticker>")
  .description("Remove from watchlist")
  .action((ticker: string) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    const ok = db.removeWatchlist(ticker.toUpperCase());
    console.log(ok ? `Removed: ${ticker.toUpperCase()}` : "Not found on watchlist");
    db.close();
  });

watchlist
  .command("list")
  .description("List watchlist")
  .action(() => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    const items = db.getWatchlist();
    if (items.length === 0) {
      console.log("Watchlist is empty");
    } else {
      console.log("\nWatchlist:");
      console.log("-".repeat(60));
      items.forEach((w) => {
        console.log(`  ${w.ticker.padEnd(8)} ${w.thesis}`);
        if (w.notes) console.log(`           ${w.notes}`);
      });
    }
    db.close();
  });

// ── Analysis ───────────────────────────────────────────────────────────────

program
  .command("analyze <ticker>")
  .description("Analyze a single ticker")
  .action(async (ticker: string) => {
    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }
    try {
      const config = getConfig();
      const db = new Db(config.getDatabasePath());
      const orchestrator = new AnalysisOrchestrator(db);
      console.log(`Analyzing ${ticker.toUpperCase()}...`);
      const signal = await orchestrator.analyzeSingleTicker(ticker.toUpperCase());
      if (signal) {
        console.log(`\n${signal.ticker}: ${signal.recommendation}`);
        console.log(`Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
        console.log(`Reasoning: ${signal.reasoning}`);
      } else {
        console.log("Analysis failed");
        process.exitCode = 1;
      }
      db.close();
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(`Configuration error: ${e.message}`);
        console.log("Run 'fstack setup' to configure");
      } else {
        console.error(`Analysis failed: ${e}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command("batch")
  .description("Run batch analysis on all positions and watchlist")
  .option("--dry-run", "Analyze without sending email")
  .action(async (opts: { dryRun?: boolean }) => {
    // Check for staging files first (matches the Python CLI's cmd_batch)
    const stagingDir = path.join("reports", "staging");
    if (fs.existsSync(stagingDir)) {
      const stagingFiles = fs.readdirSync(stagingDir).filter((f) => f.endsWith(".pdf"));
      if (stagingFiles.length > 0) {
        console.log(`\nFound ${stagingFiles.length} report(s) in staging folder.`);
        const { organizeFirst } = await prompts({
          type: "confirm",
          name: "organizeFirst",
          message: "Organize reports first?",
          initial: true,
        });
        if (organizeFirst) {
          await organizeStagedReports(
            stagingDir,
            "reports",
            path.join("reports", "archive"),
            path.join("reports", "error")
          );
        }
      }
    }

    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }

    try {
      const config = getConfig();
      const db = new Db(config.getDatabasePath());
      const orchestrator = new AnalysisOrchestrator(db);
      console.log("Running batch analysis...");
      const result = await orchestrator.runBatchAnalysis(opts.dryRun ?? false);
      console.log(`\nComplete: ${result.successCount} signals, ${result.errorCount} errors`);
      console.log(`Duration: ${result.durationSeconds.toFixed(1)}s`);
      result.signals.forEach((s) => {
        console.log(
          `  ${s.ticker.padEnd(8)} ${s.recommendation.padEnd(6)} ${(s.confidence * 100).toFixed(0)}%  ${s.reasoning}`
        );
      });
      if (Object.keys(result.errors).length) {
        console.log("\nErrors:");
        Object.entries(result.errors).forEach(([t, e]) => console.log(`  ${t}: ${e}`));
        process.exitCode = 1;
      }
      db.close();
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(`Configuration error: ${e.message}`);
        console.log("Run 'fstack setup' to configure");
      } else {
        console.error(`Batch analysis failed: ${e}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command("retry")
  .description("Retry pending failed email notifications")
  .action(async () => {
    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }
    try {
      const config = getConfig();
      const db = new Db(config.getDatabasePath());
      const orchestrator = new AnalysisOrchestrator(db);
      const count = await orchestrator.retryPendingEmails();
      console.log(`Retried ${count} notifications`);
      db.close();
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(`Configuration error: ${e.message}`);
      } else {
        console.error(`Retry failed: ${e}`);
      }
      process.exitCode = 1;
    }
  });

// ── Scheduler ──────────────────────────────────────────────────────────────

program
  .command("scheduler")
  .description("Manage cron scheduling")
  .option("--setup", "Interactive cron setup")
  .option("--list", "List installed crontab")
  .action(async (opts: { setup?: boolean; list?: boolean }) => {
    if (opts.setup) {
      const ok = await setupCronInteractive();
      if (!ok) process.exitCode = 1;
    } else if (opts.list) {
      const ok = listCronJobs();
      if (!ok) process.exitCode = 1;
    } else {
      console.log("scheduler: --setup or --list required");
      process.exitCode = 1;
    }
  });

// ── Report organization ─────────────────────────────────────────────────────

program
  .command("organize-reports")
  .description("Organize Morningstar PDFs from staging")
  .option("--staging-dir <dir>", "Staging directory", path.join("reports", "staging"))
  .option("--target-dir <dir>", "Target reports directory", "reports")
  .option("--archive-dir <dir>", "Archive directory", path.join("reports", "archive"))
  .option("--error-dir <dir>", "Error directory", path.join("reports", "error"))
  .action(
    async (opts: {
      stagingDir: string;
      targetDir: string;
      archiveDir: string;
      errorDir: string;
    }) => {
      const result = await organizeStagedReports(
        opts.stagingDir,
        opts.targetDir,
        opts.archiveDir,
        opts.errorDir
      );
      if (result.failed.length) process.exitCode = 1;
    }
  );

program
  .command("signals [ticker]")
  .description("Show recent signals (optionally filtered by ticker)")
  .option("-d, --days <days>", "Number of days to look back", "30")
  .action((ticker: string | undefined, opts: { days: string }) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    const days = parseInt(opts.days, 10);
    const signals = ticker
      ? db.getSignals(ticker.toUpperCase(), days)
      : db.getAllSignals(50);
    if (signals.length === 0) {
      console.log("No signals found");
    } else {
      console.log(`\nSignals (${signals.length}):`);
      console.log("-".repeat(80));
      signals.forEach((s) => {
        console.log(
          `  ${s.date.split("T")[0]}  ${s.ticker.padEnd(8)} ${s.recommendation.padEnd(6)} ` +
            `${(s.confidence * 100).toFixed(0)}%  ${s.reasoning}`
        );
      });
    }
    db.close();
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
