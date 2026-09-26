#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import prompts from "prompts";
import { getConfig } from "./core/config";
import { setupInteractive, validateEnv } from "./core/setup";
import { ConfigError } from "./core/errors";
import { setupCronInteractive, listCronJobs } from "./core/scheduler";
import { organizeStagedReports } from "./domains/financial/tools/reportOrganizer";
import { Db } from "./core/db";
import { AnalysisOrchestrator } from "./domains/financial/orchestrator";
import { QuoteAgent } from "./domains/financial/agents/quoteAgent";
import { EquityAgent } from "./domains/financial/agents/equityAgent";
import { TraderAgent } from "./domains/financial/agents/traderAgent";
import type { Signal } from "./core/models";

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
  .option(
    "-s, --strategy <strategy>",
    "Strategy this position is held under: long-term, swing, or both (default: long-term, or whatever it already was on update)"
  )
  .action(
    (
      ticker: string,
      sharesStr: string,
      costBasisStr: string,
      opts: { notes?: string; strategy?: string }
    ) => {
      const config = getConfig();
      const db = new Db(config.getDatabasePath());
      const shares = parseFloat(sharesStr);
      const costBasis = parseFloat(costBasisStr);
      if (isNaN(shares) || isNaN(costBasis)) {
        console.error("shares and cost_basis must be numbers");
        process.exit(1);
      }
      if (opts.strategy && !["long-term", "swing", "both"].includes(opts.strategy)) {
        console.error("--strategy must be one of: long-term, swing, both");
        process.exit(1);
      }
      // Ensure ticker exists in tickers table
      db.addTicker(ticker.toUpperCase(), ticker.toUpperCase(), "PUBLIC");
      const ok = db.addPosition(ticker.toUpperCase(), shares, costBasis, opts.notes, opts.strategy);
      console.log(ok ? `Position added: ${ticker.toUpperCase()}` : "Failed to add position");
      db.close();
    }
  );

position
  .command("strategy <ticker> <strategy>")
  .description("Set the strategy tag on an existing position without touching shares/cost basis (long-term, swing, or both)")
  .action((ticker: string, strategy: string) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    if (!["long-term", "swing", "both"].includes(strategy)) {
      console.error("strategy must be one of: long-term, swing, both");
      process.exit(1);
    }
    const ok = db.updatePositionStrategy(ticker.toUpperCase(), strategy);
    console.log(ok ? `Strategy set: ${ticker.toUpperCase()} -> ${strategy}` : "Position not found");
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
        console.log(
          `  ${p.ticker.padEnd(8)} ${p.shares} shares @ $${p.cost_basis.toFixed(2)}  [${p.strategy}]`
        );
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
  .description("[DEPRECATED] Analyze a single ticker via the legacy CfoAgent judgment path")
  .action(async (ticker: string) => {
    console.warn(
      "⚠ 'fstack analyze' uses the deprecated CfoAgent path (bypasses domains/financial/skills/). " +
        "Prefer: fstack data-dump, reason over it with the skill files, then fstack notify. See skills/INDEX.md."
    );
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
  .description("[DEPRECATED] Run batch analysis via the legacy CfoAgent judgment path")
  .option("--dry-run", "Analyze without sending email")
  .action(async (opts: { dryRun?: boolean }) => {
    console.warn(
      "⚠ 'fstack batch' uses the deprecated CfoAgent path (bypasses domains/financial/skills/). " +
        "Prefer: fstack data-dump, reason over it with the skill files, then fstack notify. See skills/INDEX.md."
    );
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

// ── Data dump for a Claude-driven analysis (deterministic only, no CFO call) ─
// This is the "fat code" half of the thin-harness/fat-skills split: it fetches
// and computes numbers (quotes, technicals, Morningstar fundamentals) and does
// no judgment. A Claude session reads this JSON plus domains/financial/skills/
// and the shared brain/ (~/Documents/personal-brain/financial/brain/) and does
// the actual BUY/SELL/HOLD reasoning — see domains/financial/skills/INDEX.md.

program
  .command("data-dump")
  .description(
    "Dump quote + fundamentals data for all positions/watchlist tickers as JSON. " +
      "No CFO/Claude call — purely deterministic data for an external judgment step to consume."
  )
  .action(async () => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    try {
      const positions = db.getAllPositions();
      const watchlist = db.getWatchlist();
      const positionsByTicker = Object.fromEntries(positions.map((p) => [p.ticker, p]));
      const watchlistByTicker = Object.fromEntries(watchlist.map((w) => [w.ticker, w]));
      const allTickers = [...new Set([...positions.map((p) => p.ticker), ...watchlist.map((w) => w.ticker)])];

      if (allTickers.length === 0) {
        console.log(JSON.stringify([]));
        return;
      }

      const quoteAgent = new QuoteAgent(config.getFinnhubApiKey(), db);
      const equityAgent = new EquityAgent();

      // QuoteAgent writes quote+indicators into the db as a side effect; read
      // them back from there rather than from its return value, which doesn't
      // include RSI/MA (those are computed and persisted, not returned).
      await quoteAgent.batchAnalyze(allTickers);
      const equities = await equityAgent.batchAnalyze(allTickers);

      const output = allTickers.map((ticker) => {
        const pos = positionsByTicker[ticker];
        const watch = watchlistByTicker[ticker];
        return {
          ticker,
          isPosition: !!pos,
          isWatchlist: !!watch,
          positionStrategyTag: pos?.strategy ?? null,
          shares: pos?.shares ?? null,
          costBasis: pos?.cost_basis ?? null,
          watchlistThesis: watch?.thesis ?? null,
          quote: db.getLatestQuote(ticker) ?? null,
          equity: equities[ticker] ?? null,
        };
      });

      console.log(JSON.stringify(output, null, 2));
    } finally {
      db.close();
    }
  });

program
  .command("notify")
  .description(
    "Send a batch email for a set of signals and record them in signal history. " +
      "Deterministic — takes already-decided recommendations, does no judgment itself."
  )
  .option(
    "--file <path>",
    "Path to a JSON file with an array of {ticker, recommendation, confidence, reasoning, fromWatchlist?}. Reads stdin if omitted."
  )
  .action(async (opts: { file?: string }) => {
    const config = getConfig();
    const db = new Db(config.getDatabasePath());
    try {
      const raw = opts.file ? fs.readFileSync(opts.file, "utf8") : fs.readFileSync(0, "utf8");
      const parsed = JSON.parse(raw) as Array<{
        ticker: string;
        recommendation: "BUY" | "SELL" | "HOLD";
        confidence: number;
        reasoning: string;
        fromWatchlist?: boolean;
      }>;
      const signals: Signal[] = parsed.map((s) => ({
        ticker: s.ticker.toUpperCase(),
        recommendation: s.recommendation,
        confidence: s.confidence,
        reasoning: s.reasoning,
        date: new Date(),
        fromWatchlist: s.fromWatchlist ?? false,
        createdAt: new Date(),
      }));
      const trader = new TraderAgent(
        db,
        config.getGmailAddress(),
        config.getGmailAppPassword(),
        config.getNotificationEmail()
      );
      const ok = await trader.sendBatchEmail(signals);
      console.log(ok ? `Email sent: ${signals.length} signals` : "Email failed, queued for retry");
      if (!ok) process.exitCode = 1;
    } finally {
      db.close();
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
