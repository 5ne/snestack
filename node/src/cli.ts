#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { getConfig, type ModelTier } from "./core/config";
import { ExecutorError } from "./core/errors";
import { setupInteractive, validateEnv } from "./core/setup";
import { organizeStagedReports } from "./domains/financial/tools/reportOrganizer";
import { Db } from "./core/db";
import { runSkill, assembleSkillPrompt, evaluateSkillGate } from "./core/runSkill";
import { runPrompt } from "./core/executor";
import { authorizeGoogleCalendar } from "./domains/calendar/setup";
import { authorizeGmail } from "./domains/travel/setup";
import { parseMultiFileOutput, writeStagedCatalogFiles, writeCatalogFilesToDir } from "./domains/travel/tools/fileWriter";
import { nextBackfillYear, BACKFILL_START_YEAR, BACKFILL_END_YEAR } from "./domains/travel/tools/backfill";
import { logRunEvent, finalizeRun, currentRunDir, extractErrorSummary, readRunEvents } from "./core/runLog";
import { buildSignalsFromDir, filterUnchangedSignals } from "./domains/financial/tools/signalBuilder";
import { writeVerified } from "./core/safeWrite";
import { buildRunReport, formatRunReportText } from "./core/runReport";
import { evaluateRuns, checkCacheStaleness, dayString, type RunExpectation } from "./core/runCheck";
import { QuoteAgent } from "./domains/financial/agents/quoteAgent";
import { EquityAgent, defaultReportsDir } from "./domains/financial/agents/equityAgent";
import { TraderAgent } from "./domains/financial/agents/traderAgent";
import { resolveTickerUniverse, loadCacheAgeGetters } from "./domains/financial/cliHelpers";
import { financialRunExpectations, financialRunStatsTargets } from "./domains/financial/runExpectations";
import { computeRunStats, formatRunStats } from "./core/runStats";
import { runDataRefresh, DATA_REFRESH_TIERS, type DataRefreshTier } from "./domains/financial/dataRefresh";
import { equityDataFromCache } from "./domains/financial/fundamentalsCache";
import type { Signal } from "./core/models";
import { getDomainConfig } from "./core/domainRegistry";
import {
  listProposals,
  findProposalBySlug,
  setProposalStatus,
  readProposalFile,
  type ProposalStatus,
} from "./core/featureRequests";
import { sendEmail } from "./core/email";
import domainsConfig from "./config/domains.json";

const program = new Command();

const REGISTERED_DOMAINS = Object.keys(domainsConfig);
// Cross-domain (harness-level) proposals live under <brain>/_system/feature-requests/ (see core/skills/pm.md).
// `_system` isn't a runnable domain; only `feature` commands see it.
const FEATURE_DOMAINS = [...REGISTERED_DOMAINS, "_system"];

program
  .name("snestack")
  .description("Personal decision-support harness (financial and calendar domains, more planned)")
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

const calendar = program.command("calendar").description("Google Calendar domain setup");

calendar
  .command("auth")
  .description(
    "One-time OAuth consent for read-only Google Calendar access. " +
      "Requires SNESTACK_GOOGLE_CLIENT_ID/SNESTACK_GOOGLE_CLIENT_SECRET already set — see node/README.md."
  )
  .option("--env-file <path>", "Path to .env file (default: .env)")
  .action(async (opts: { envFile?: string }) => {
    const ok = await authorizeGoogleCalendar(opts.envFile);
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
    async (
      ticker: string,
      sharesStr: string,
      costBasisStr: string,
      opts: { notes?: string; strategy?: string }
    ) => {
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
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
      await db.addTicker(ticker.toUpperCase(), ticker.toUpperCase(), "PUBLIC");
      const ok = await db.addPosition(ticker.toUpperCase(), shares, costBasis, opts.notes, opts.strategy);
      console.log(ok ? `Position added: ${ticker.toUpperCase()}` : "Failed to add position");
      await db.close();
    }
  );

position
  .command("strategy <ticker> <strategy>")
  .description("Set the strategy tag on an existing position without touching shares/cost basis (long-term, swing, or both)")
  .action(async (ticker: string, strategy: string) => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    if (!["long-term", "swing", "both"].includes(strategy)) {
      console.error("strategy must be one of: long-term, swing, both");
      process.exit(1);
    }
    const ok = await db.updatePositionStrategy(ticker.toUpperCase(), strategy);
    console.log(ok ? `Strategy set: ${ticker.toUpperCase()} -> ${strategy}` : "Position not found");
    await db.close();
  });

position
  .command("remove <ticker>")
  .description("Remove a portfolio position")
  .action(async (ticker: string) => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    const ok = await db.removePosition(ticker.toUpperCase());
    console.log(ok ? `Position removed: ${ticker.toUpperCase()}` : "Position not found");
    await db.close();
  });

position
  .command("list")
  .description("List all positions")
  .action(async () => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    const positions = await db.getAllPositions();
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
    await db.close();
  });

// ── Watchlist management ───────────────────────────────────────────────────

const watchlist = program.command("watchlist").description("Manage watchlist");

watchlist
  .command("add <ticker> <thesis>")
  .description("Add ticker to watchlist")
  .option("-n, --notes <notes>", "Additional notes")
  .action(async (ticker: string, thesis: string, opts: { notes?: string }) => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    await db.addTicker(ticker.toUpperCase(), ticker.toUpperCase(), "PUBLIC");
    const ok = await db.addWatchlist(ticker.toUpperCase(), thesis, opts.notes);
    console.log(ok ? `Watchlist added: ${ticker.toUpperCase()}` : "Failed to add watchlist item");
    await db.close();
  });

watchlist
  .command("remove <ticker>")
  .description("Remove from watchlist")
  .action(async (ticker: string) => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    const ok = await db.removeWatchlist(ticker.toUpperCase());
    console.log(ok ? `Removed: ${ticker.toUpperCase()}` : "Not found on watchlist");
    await db.close();
  });

watchlist
  .command("list")
  .description("List watchlist")
  .action(async () => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    const items = await db.getWatchlist();
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
    await db.close();
  });

// ── Report organization ─────────────────────────────────────────────────────

program
  .command("organize-reports")
  .description("Organize Morningstar PDFs from staging")
  .option("--staging-dir <dir>", "Staging directory", path.join(defaultReportsDir(), "staging"))
  .option("--target-dir <dir>", "Target reports directory", defaultReportsDir())
  .option("--archive-dir <dir>", "Archive directory", path.join(defaultReportsDir(), "archive"))
  .option("--error-dir <dir>", "Error directory", path.join(defaultReportsDir(), "error"))
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
  .action(async (ticker: string | undefined, opts: { days: string }) => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    const days = parseInt(opts.days, 10);
    const signals = ticker
      ? await db.getSignals(ticker.toUpperCase(), days)
      : await db.getAllSignals(50);
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
    await db.close();
  });

// ── Data dump for a Claude-driven analysis (deterministic only, no model call) ─
// This is the "fat code" half of the thin-harness/fat-skills split: it fetches
// and computes numbers (quotes, technicals, Morningstar fundamentals) and does
// no judgment. A Claude session reads this JSON plus domains/financial/skills/
// and the shared brain/ (~/Documents/personal-brain/financial/brain/) and does
// the actual BUY/SELL/HOLD reasoning — see domains/financial/skills/INDEX.md.

program
  .command("data-dump")
  .description(
    "Print cached quote + fundamentals data for all positions/watchlist tickers as JSON — a pure " +
      "reporting view over what `data-refresh` last wrote, with no Finnhub/Morningstar calls of its " +
      "own. Useful for a manual sanity check. Run `data-refresh --tier daily` (and `--tier weekly` " +
      "for Morningstar) first if the cache is empty or stale; this command will not populate it."
  )
  .action(async () => {
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    try {
      const positions = await db.getAllPositions();
      const watchlist = await db.getWatchlist();
      const positionsByTicker = Object.fromEntries(positions.map((p) => [p.ticker, p]));
      const watchlistByTicker = Object.fromEntries(watchlist.map((w) => [w.ticker, w]));
      const allTickers = await resolveTickerUniverse(db);

      if (allTickers.length === 0) {
        console.log(JSON.stringify([]));
        return;
      }

      const output = await Promise.all(allTickers.map(async (ticker) => {
        const pos = positionsByTicker[ticker];
        const watch = watchlistByTicker[ticker];
        const fundRow = await db.getLatestFundamentals(ticker, "morningstar");
        return {
          ticker,
          isPosition: !!pos,
          isWatchlist: !!watch,
          positionStrategyTag: pos?.strategy ?? null,
          shares: pos?.shares ?? null,
          costBasis: pos?.cost_basis ?? null,
          watchlistThesis: watch?.thesis ?? null,
          quote: (await db.getLatestQuote(ticker)) ?? null,
          equity: fundRow ? equityDataFromCache(fundRow) : null,
        };
      }));

      console.log(JSON.stringify(output, null, 2));
    } finally {
      await db.close();
    }
  });

// ── Tiered data refresh (core of the harness/data-pipeline migration) ──────
// The dispatch logic lives in domains/financial/dataRefresh.ts (importable
// without triggering this file's program.parseAsync side effect below, so it
// can be unit-tested directly) — this is just the CLI wiring around it.

program
  .command("data-refresh")
  .description(
    "Refresh cached quote/technicals/fundamentals for positions+watchlist tickers, scoped by tier. " +
      "intraday: quote + RSI/MA only (skips Finnhub fundamentals). " +
      "daily: quote + RSI/MA + Finnhub live fundamentals. " +
      "weekly: Morningstar PDF re-parse only. " +
      "This is the only command that calls Finnhub/Twelve Data/Morningstar — run-skill and data-dump " +
      "read only from the cache this leaves behind."
  )
  .requiredOption("--tier <tier>", "intraday | daily | weekly")
  .option("--tickers <list>", "comma-separated subset; default: all positions+watchlist")
  .action(async (opts: { tier: string; tickers?: string }) => {
    if (!DATA_REFRESH_TIERS.includes(opts.tier as DataRefreshTier)) {
      console.error(`Invalid --tier "${opts.tier}" — expected one of: ${DATA_REFRESH_TIERS.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    try {
      const { tickers, failed } = await runDataRefresh(opts.tier as DataRefreshTier, opts.tickers, { config, db });
      if (failed.length > 0) {
        console.error(`data-refresh ${opts.tier}: ${failed.length}/${tickers.length} ticker(s) failed: ${failed.join(", ")}`);
      }
      if (tickers.length === 0) {
        console.log(`No tickers to refresh (no positions/watchlist entries, and no --tickers given).`);
        return;
      }
      console.log(`Refreshed ${opts.tier} tier for ${tickers.length} ticker(s): ${tickers.join(", ")}`);
    } finally {
      await db.close();
    }
  });

// ── Skill harness (core/runSkill) ───────────────────────────────────────────
// The formal replacement for the manual "read data-dump JSON + skill markdown
// + brain by hand" flow: loads the named skill's frontmatter, resolves its
// `requires`/`references` via the domain's context tools, and runs the
// assembled prompt through the model. Prints the model's raw reasoning —
// still your call whether/how to turn that into a `notify --file` payload.

program
  .command("run-skill <domain> <skill> <subject>")
  .description(
    "Run a named skill against a subject through the core harness " +
      "(e.g. run-skill financial long-term-quality NVDA)"
  )
  .option(
    "--gated",
    "Apply the skill's own `gate:` triggers first and exit 4 without a model call when none fire (see core/gate.ts)"
  )
  .option(
    "--out <file>",
    "Write the write-up to this file (and read it back to confirm) instead of stdout. Exit 5 if the file doesn't hold what was written."
  )
  .action(async (domain: string, skill: string, subject: string, opts: { gated?: boolean; out?: string }) => {
    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }
    try {
      if (opts.gated) {
        const decision = await evaluateSkillGate(domain, skill, subject);
        if (!decision.run) {
          // Exit code 4 = skipped by the gate (not an error); automation records it as skipped.
          console.error(`gate: skipped ${domain}/${skill} ${subject} - ${decision.reasons.join("; ")}`);
          process.exitCode = 4;
          return;
        }
        console.error(`gate: running ${domain}/${skill} ${subject} - ${decision.reasons.join("; ")}`);
      }
      const result = await runSkill(domain, skill, subject);
      if (!result.output.trim()) {
        console.error(
          `run-skill failed: model returned no text (stop_reason: ${result.stopReason}, output_tokens: ${result.outputTokensUsed})`
        );
        process.exitCode = 1;
        return;
      }
      const text = `\n=== ${result.domain}/${result.skill} — ${result.subject} ===\n\n${result.output}\n`;
      if (opts.out) {
        const problem = writeVerified(opts.out, text);
        if (problem) {
          // Exit 5 = the model call worked but its output didn't land on disk; callers may retry.
          console.error(`run-skill failed: ${problem}`);
          process.exitCode = 5;
          return;
        }
      } else {
        process.stdout.write(text);
      }
      if (result.verdictRequired && !result.verdict) {
        console.error('run-skill failed: the output has no valid "VERDICT: LABEL | confidence | reasoning" line');
        process.exitCode = 1;
        return;
      }
      if (result.stopReason === "max_tokens") {
        // Exit code 3 = output kept but cut off, so automation can tell it from a clean run or a failure.
        console.error(`run-skill warning: output truncated at max_tokens (${result.outputTokensUsed} output tokens)`);
        process.exitCode = 3;
      }
    } catch (e) {
      console.error(`run-skill failed: ${e}`);
      process.exitCode = 1;
    }
  });

// ── Travel domain ────────────────────────────────────────────────────────
// Two ways to run catalog-trip-year — see that skill file for the full
// tradeoff. `travel auth` + `travel catalog` is the fully automated,
// deterministic-fetch-then-one-model-call path (what the nightly cron runs).
// `travel prep-catalog` is the manual path: it assembles the skill + that
// year's Timeline clusters into one prompt for a Claude session that has
// real Gmail + Google Maps access to search interactively.

const travel = program.command("travel").description("Travel brain domain");

travel
  .command("auth")
  .description(
    "One-time OAuth consent for read-only Gmail access, needed before `travel catalog`. " +
      "Requires SNESTACK_GOOGLE_CLIENT_ID/SNESTACK_GOOGLE_CLIENT_SECRET already set (the same " +
      "Google Cloud OAuth client the calendar domain uses) and the Gmail API enabled on that " +
      "project — see node/README.md."
  )
  .option("--env-file <path>", "Path to .env file (default: .env)")
  .action(async (opts: { envFile?: string }) => {
    const ok = await authorizeGmail(opts.envFile);
    if (!ok) process.exitCode = 1;
  });

travel
  .command("catalog <year>")
  .description(
    "Fully automated catalog-trip-year run: fetches Gmail (metadata + snippets only, via a fixed " +
      "search) and the year's Timeline clusters deterministically, runs the skill in a single " +
      "model call, and writes the resulting per-trip files + index to " +
      "<SNESTACK_BRAIN_ROOT>/travel/<year>/.nightly-draft/ — a staging directory, not the " +
      "canonical files, since this path is lower-fidelity than a manual run (see the skill file). " +
      "Review the draft and move files into place yourself. Requires `travel auth` first. This is " +
      "what scripts/travel-catalog-nightly.sh runs on a cron."
  )
  .option(
    "--out-dir <dir>",
    "Write the files here instead of the year's .nightly-draft/ staging directory (used by dry runs so they leave no trace in the real catalog)"
  )
  .action(async (year: string, opts: { outDir?: string }) => {
    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }
    if (!/^\d{4}$/.test(year)) {
      console.error(`Expected a 4-digit year, got "${year}"`);
      process.exitCode = 1;
      return;
    }
    try {
      console.error(`Fetching Gmail + Timeline context and running catalog-trip-year for ${year}...`);
      const result = await runSkill("travel", "catalog-trip-year", year);
      const files = parseMultiFileOutput(result.output);
      if (Object.keys(files).length === 0) {
        console.error("No '### FILE:' blocks found in the model output — nothing written.");
        console.error(
          `stop_reason: ${result.stopReason}, output_tokens: ${result.outputTokensUsed}` +
            (result.stopReason === "max_tokens"
              ? " — ran out of budget (often to thinking, which shares the same budget) before writing " +
                "visible text; try raising maxTokens in catalog-trip-year.md's frontmatter"
              : "")
        );
        console.error("Raw output:");
        console.error(result.output);
        process.exitCode = 1;
        return;
      }
      const written = opts.outDir
        ? writeCatalogFilesToDir(opts.outDir, files)
        : writeStagedCatalogFiles(getConfig().getBrainRoot(), parseInt(year, 10), files);
      console.log(
        `Wrote ${written.length} file(s) to ${opts.outDir ?? "the .nightly-draft/ staging directory"}:`
      );
      written.forEach((p) => console.log(`  ${p}`));
      if (result.stopReason === "max_tokens") {
        console.log(
          `\nNote: stopped at max_tokens (${result.outputTokensUsed} output tokens) — the response may ` +
            "have been cut off mid-file, or an expected file (e.g. the index) may be missing entirely. " +
            "Check the files above before assuming the run is complete."
        );
        process.exitCode = 3;
      }
      console.log("\nReview before promoting into the year's canonical files.");
    } catch (e) {
      console.error(`travel catalog failed: ${e}`);
      process.exitCode = 1;
    }
  });

travel
  .command("prep-catalog <year>")
  .description(
    "Assemble the catalog-trip-year skill for <year> (skill body + that year's Google Maps " +
      "Timeline clusters) into one prompt, ready to paste into a Claude session with Gmail + " +
      "Maps access. Writes to stdout, or --out <file>."
  )
  .option("--out <path>", "Write the assembled prompt to a file instead of stdout")
  .action(async (year: string, opts: { out?: string }) => {
    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }
    if (!/^\d{4}$/.test(year)) {
      console.error(`Expected a 4-digit year, got "${year}"`);
      process.exitCode = 1;
      return;
    }
    try {
      const { userPrompt } = await assembleSkillPrompt("travel", "catalog-trip-year", year);
      if (opts.out) {
        fs.writeFileSync(opts.out, userPrompt, "utf8");
        console.error(`Wrote assembled prompt to ${opts.out}`);
      } else {
        console.log(userPrompt);
      }
    } catch (e) {
      console.error(`travel prep-catalog failed: ${e}`);
      process.exitCode = 1;
    }
  });

program
  .command("distill-signals")
  .description(
    "[No longer used by daily-analysis.sh — see build-signals] Turn a directory of run-skill output files into a notify-ready signals JSON array, " +
      "via a single Claude call over all of them at once. Reads every " +
      "*-long-term-quality.md / *-swing-trading-large-cap.md file in --dir, plus that " +
      "dir's data-dump.json (if present) for isWatchlist flags. Prints the JSON array to " +
      "stdout — pipe it to a file, then pass that file to `notify --file`. " +
      "Unlike run-skill, this makes no fresh judgment of its own: it summarizes the " +
      "judgments those skill runs already made into the schema notify expects."
  )
  .requiredOption("--dir <path>", "Directory containing run-skill output files (and optionally data-dump.json)")
  .action(async (opts: { dir: string }) => {
    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }
    const config = getConfig();
    const dir = opts.dir;
    if (!fs.existsSync(dir)) {
      console.error(`Directory not found: ${dir}`);
      process.exitCode = 1;
      return;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith("-long-term-quality.md") || f.endsWith("-swing-trading-large-cap.md"));
    if (files.length === 0) {
      console.error(`No *-long-term-quality.md or *-swing-trading-large-cap.md files found in ${dir}`);
      process.exitCode = 1;
      return;
    }

    const watchlistTickers = new Set<string>();
    const dumpPath = path.join(dir, "data-dump.json");
    if (fs.existsSync(dumpPath)) {
      try {
        const raw = fs.readFileSync(dumpPath, "utf8");
        // data-dump.json may have colored logger lines above the JSON array if it
        // was captured with `tee`/stdout rather than redirected cleanly — the
        // array itself always starts at a line that is exactly "[".
        const lines = raw.split("\n");
        const arrayStartLine = lines.findIndex((l) => l === "[");
        if (arrayStartLine === -1) throw new Error("no JSON array found (no line is exactly '[')");
        const arr = JSON.parse(lines.slice(arrayStartLine).join("\n")) as Array<{
          ticker: string;
          isWatchlist: boolean;
        }>;
        arr.forEach((e) => {
          if (e.isWatchlist) watchlistTickers.add(e.ticker);
        });
      } catch (e) {
        console.error(`Warning: could not parse ${dumpPath} for watchlist flags: ${e}`);
      }
    }

    const sections = files
      .sort()
      .map((f) => `### FILE: ${f}\n${fs.readFileSync(path.join(dir, f), "utf8")}`)
      .join("\n\n---\n\n");

    const systemPrompt =
      "You distill a batch of already-completed investment judgment write-ups into a single " +
      "strict JSON array for a downstream notification step. You are not re-deciding anything — " +
      "each input file already contains a final recommendation from a domain skill; your job is " +
      "purely mechanical extraction and format translation. Output ONLY the JSON array — no prose, " +
      "no markdown code fences, no commentary before or after.";

    const userPrompt = [
      `WATCHLIST TICKERS (fromWatchlist should be true for these, false for all others): ${
        [...watchlistTickers].join(", ") || "(none)"
      }`,
      "",
      "For each file below, extract one JSON object:",
      "- ticker: the ticker symbol",
      '- recommendation: "BUY", "SELL", or "HOLD" — map the skill\'s own vocabulary onto these three ' +
        '(e.g. "BUY-MORE"/"TACTICAL BUY" -> BUY, "TRIM"/"SELL/TRIM" -> SELL)',
      "- confidence: your best-effort 0.0-1.0 read of how strongly the file's own reasoning supports its call",
      "- reasoning: 1-2 sentences summarizing the file's actual reasoning, prefixed with [Long-term] or " +
        "[Swing] depending on which file it came from",
      "- fromWatchlist: true/false per the watchlist ticker list above",
      "",
      "Skip a swing-trading file entirely if it explicitly says the ticker is INELIGIBLE for the " +
      "swing strategy (failed eligibility filter) — that is not a recommendation, don't invent one. " +
      "A ticker can legitimately appear twice (once per skill) if both produced a call.",
      "",
      sections,
    ].join("\n");

    const { output } = await runPrompt(config.getExecutorApiKey(), systemPrompt, userPrompt, {
      tier: "cheap",
      maxTokens: 8000,
      label: "financial/distill-signals",
    });
    const cleaned = output
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.error(`Model output was not valid JSON: ${e}`);
      console.error(output);
      process.exitCode = 1;
    }
  });

program
  .command("notify-summary")
  .description(
    "Email a run summary built from the run's logs, for runs with no new recommendations (\"no changes today\") " +
      "or that didn't complete cleanly (\"run had problems\"). Deterministic, no model call."
  )
  .requiredOption("--dir <path>", "Run directory containing run.jsonl")
  .option("--dry-run", "Print the summary instead of emailing it")
  .action(async (opts: { dir: string; dryRun?: boolean }) => {
    const events = readRunEvents(opts.dir);
    if (events.length === 0) {
      console.error(`notify-summary: no run events found in ${opts.dir}`);
      process.exitCode = 1;
      return;
    }
    const report = buildRunReport(events);
    if (opts.dryRun) {
      console.log(`[dry-run] Would email a ${report.status === "failed" ? "run-problems" : "no-changes"} summary:\n`);
      console.log(formatRunReportText(report));
      return;
    }
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
    try {
      const trader = new TraderAgent(db, config.getGmailAddress(), config.getGmailAppPassword(), config.getNotificationEmail());
      const ok = await trader.sendRunSummaryEmail(report);
      console.log(ok ? "Run summary email sent" : "Run summary email failed");
      if (!ok) process.exitCode = 1;
    } finally {
      await db.close();
    }
  });

program
  .command("build-signals")
  .description(
    "Build the notify-ready signals array from a run directory by reading each skill write-up's trailing " +
      "`VERDICT:` line. Deterministic, no model call. Prints the JSON array to stdout; files with a missing " +
      "or invalid verdict are listed on stderr and make the command exit 1 (the valid signals are still printed)."
  )
  .requiredOption("--dir <path>", "Run directory containing *-long-term-quality.md / *-swing-trading-large-cap.md files")
  .option(
    "--only-changed",
    "Drop any signal whose recommendation matches the last one recorded for that ticker+strategy and whose " +
      "confidence hasn't moved by --confidence-move either — for a skill run several times a day, an unmoved " +
      "verdict otherwise re-emails the same call every time."
  )
  .option(
    "--confidence-move <pct>",
    "With --only-changed: still treat a same-recommendation signal as changed if confidence moved at least this much (0-1)",
    "0.1"
  )
  .action(async (opts: { dir: string; onlyChanged?: boolean; confidenceMove: string }) => {
    if (!fs.existsSync(opts.dir)) {
      console.error(`Directory not found: ${opts.dir}`);
      process.exitCode = 1;
      return;
    }
    const result = buildSignalsFromDir(opts.dir);
    let signals = result.signals;
    let unchangedCount = 0;
    if (opts.onlyChanged) {
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const filtered = await filterUnchangedSignals(db, result.signals, parseFloat(opts.confidenceMove));
        signals = filtered.changed;
        unchangedCount = filtered.unchanged.length;
      } finally {
        await db.close();
      }
    }
    console.log(JSON.stringify(signals, null, 2));
    console.error(
      `build-signals: ${signals.length} signals, ${result.noSignal.length} with nothing to report, ${result.errors.length} errors` +
        (opts.onlyChanged ? `, ${unchangedCount} unchanged from last time (dropped)` : "")
    );
    result.errors.forEach((e) => console.error(`  ERROR ${e}`));
    if (result.errors.length > 0) process.exitCode = 1;
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
  .option("--dry-run", "Print what would be sent and exit — no email, nothing recorded in the signals table")
  .option("--run-dir <dir>", "Append a summary of this run (from its run.jsonl) to the email; defaults to $SNESTACK_RUN_DIR")
  .action(async (opts: { file?: string; dryRun?: boolean; runDir?: string }) => {
    if (opts.dryRun) {
      const raw = opts.file ? fs.readFileSync(opts.file, "utf8") : fs.readFileSync(0, "utf8");
      const preview = JSON.parse(raw) as Array<{ ticker: string; recommendation: string; confidence: number }>;
      const tally = (r: string) => preview.filter((s) => s.recommendation === r).length;
      console.log(
        `[dry-run] Would email ${preview.length} signals (${tally("BUY")} BUY, ${tally("SELL")} SELL, ${tally("HOLD")} HOLD); nothing sent or recorded.`
      );
      preview.forEach((s) => console.log(`  ${s.ticker.padEnd(6)} ${s.recommendation.padEnd(5)} ${s.confidence}`));
      return;
    }
    const config = getConfig();
    const db = await Db.open(config.getDatabaseUrl());
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
      const runDir = opts.runDir ?? currentRunDir();
      const events = runDir ? readRunEvents(runDir) : [];
      const ok = await trader.sendBatchEmail(signals, {}, {}, undefined, events.length ? buildRunReport(events) : undefined);
      console.log(ok ? `Email sent: ${signals.length} signals` : "Email failed (signals not recorded)");
      if (!ok) process.exitCode = 1;
    } finally {
      await db.close();
    }
  });


// ── Run logging & health checks ─────────────────────────────────────────────
// Automation scripts record structured run events (see core/runLog.ts) so a
// failed, truncated or missing run can be diagnosed — by a person or a watcher
// agent — without re-running anything.

const runLog = program.command("run-log").description("Record structured events for an automation run");

runLog
  .command("event <type>")
  .description("Append an event to the active run's run.jsonl (dir from SNESTACK_RUN_DIR unless --dir is given)")
  .option("--dir <dir>", "Run directory (default: $SNESTACK_RUN_DIR)")
  .option("--script <name>", "run_start: the automation's name")
  .option("--dry-run", "run_start: mark this run as a dry run")
  .option("--step <name>", "step: what ran, e.g. data-dump or run-skill:long-term-quality")
  .option("--subject <s>", "step: what it ran on, e.g. a ticker or year")
  .option("--status <s>", "step: ok | failed | truncated | skipped")
  .option("--exit-code <n>", "step: the command's exit code")
  .option("--duration-ms <n>", "step: how long it took")
  .option("--error-file <path>", "step: file whose last 500 bytes become the error text")
  .action(
    (
      type: string,
      opts: {
        dir?: string;
        script?: string;
        dryRun?: boolean;
        step?: string;
        subject?: string;
        status?: string;
        exitCode?: string;
        durationMs?: string;
        errorFile?: string;
      }
    ) => {
      const fields: Record<string, unknown> = {};
      if (opts.script) fields.script = opts.script;
      if (type === "run_start") fields.dry_run = Boolean(opts.dryRun);
      if (opts.step) fields.step = opts.step;
      if (opts.subject) fields.subject = opts.subject;
      if (opts.status) fields.status = opts.status;
      if (opts.exitCode !== undefined) fields.exit_code = parseInt(opts.exitCode, 10);
      if (opts.durationMs !== undefined) fields.duration_ms = parseInt(opts.durationMs, 10);
      if (opts.errorFile && opts.status !== "ok" && fs.existsSync(opts.errorFile)) {
        const summary = extractErrorSummary(fs.readFileSync(opts.errorFile, "utf8"));
        // "error" is reserved for real failures; skipped/truncated steps get "detail" (e.g. the gate's reason).
        fields[opts.status === "failed" ? "error" : "detail"] = summary;
      }
      logRunEvent(type, fields, opts.dir ?? currentRunDir());
    }
  );

runLog
  .command("finalize")
  .description("Fold the run's events into run.json and print a one-line summary; exits 1 if the run failed")
  .option("--dir <dir>", "Run directory (default: $SNESTACK_RUN_DIR)")
  .option("--exit-code <n>", "The automation script's own exit code")
  .action(async (opts: { dir?: string; exitCode?: string }) => {
    const dir = opts.dir ?? currentRunDir();
    if (!dir) {
      console.error("run-log finalize: no run directory (set SNESTACK_RUN_DIR or pass --dir)");
      process.exitCode = 1;
      return;
    }
    const summary = finalizeRun(dir, opts.exitCode !== undefined ? parseInt(opts.exitCode, 10) : null);
    const m = summary.model_calls;
    console.error(
      `Run ${summary.status}: ${summary.steps.ok}/${summary.steps.total} steps ok, ${summary.steps.failed} failed, ` +
        `${summary.steps.truncated} truncated; ${m.count} model calls (${m.input_tokens} in / ${m.output_tokens} out tokens, ` +
        `~${m.est_cost_usd == null ? "unknown cost" : "$" + m.est_cost_usd.toFixed(2)}` +
        `${m.api_equivalent_usd ? `, subscription calls ~$${m.api_equivalent_usd.toFixed(2)} at API prices` : ""}` +
        `${m.api_fallbacks ? `; WARNING ${m.api_fallbacks} call(s) fell back to the metered API` : ""}). Summary: ${path.join(dir, "run.json")}`
    );
    if (summary.status === "failed") process.exitCode = 1;
  });

program
  .command("executor-check")
  .description("Smoke test: send one tiny prompt through the selected backend (SNESTACK_EXECUTOR) and print backend, model, tokens, latency")
  .option("--tier <t>", "cheap | normal | expensive", "cheap")
  .action(async (opts: { tier: string }) => {
    const config = getConfig();
    try {
      const tier = opts.tier as ModelTier;
      const backend = config.getExecutorBackend();
      const keyStripped = backend === "claude-cli" && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
      const r = await runPrompt(config.getExecutorApiKey(), "You are a smoke test. Reply with exactly: OK", "ping", {
        tier,
        maxTokens: 50,
        label: "executor-check",
      });
      console.log(`backend: ${backend}`);
      console.log(`model: ${r.model}`);
      console.log(`reply: ${r.output.trim().slice(0, 80)}`);
      console.log(`tokens: ${r.inputTokensUsed ?? "?"} in / ${r.outputTokensUsed ?? "?"} out; latency ${r.latencyMs}ms; stop ${r.stopReason ?? "?"}`);
      if (backend === "claude-cli") console.log(`API key env stripped from child: ${keyStripped ? "yes (was set in this shell)" : "n/a (was not set)"}`);
    } catch (e) {
      console.error(`executor-check failed: ${e instanceof ExecutorError ? `[${e.code}] ` : ""}${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  });

program
  .command("run-check")
  .description(
    "Check recent automation runs for problems: missing or crashed runs, failed or truncated steps, model errors, " +
      "cost spikes, and (for the financial domain) stale cached data despite refreshes having run. Prints " +
      "findings; exits 1 if any are errors. Meant for a person or a watcher agent to read."
  )
  .option("--days <n>", "How many days back to check, including today", "3")
  .option("--json", "Print findings as JSON")
  .option(
    "--cost",
    "Instead of health findings, print a read-only cost rollup per script and per domain over 7 and 30 days: " +
      "estimated cost, model calls, gate skip ratio, and the share of model calls that repeated the previous verdict for the same subject"
  )
  .action(async (opts: { days: string; json?: boolean; cost?: boolean }) => {
    const brainRoot = getConfig().getBrainRoot();
    if (opts.cost) {
      const stats = computeRunStats(financialRunStatsTargets(brainRoot), new Date());
      console.log(opts.json ? JSON.stringify({ computed_at: new Date().toISOString(), ...stats }, null, 2) : formatRunStats(stats));
      return;
    }
    // The nightly travel backfill is deprecated and unscheduled (see scripts/travel-catalog-backfill.sh),
    // so no travel run is expected. Add a { name: "travel-backfill", runsRoot: <brain>/travel/_runs, ... }
    // expectation back here if it's ever rescheduled.
    const expectations: RunExpectation[] = financialRunExpectations(brainRoot);
    const findings = evaluateRuns({ now: new Date(), days: Math.max(1, parseInt(opts.days, 10) || 3), expectations });

    const config = getConfig();
    try {
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const tickers = await resolveTickerUniverse(db);
        findings.push(...checkCacheStaleness({ now: new Date(), tickers, ...(await loadCacheAgeGetters(db, tickers)) }));
      } finally {
        await db.close();
      }
    } catch (e) {
      // Supabase unreachable (or SNESTACK_DATABASE_URL unset): say so plainly instead of reporting a clean bill of health.
      findings.push({
        severity: "error",
        domain: "financial",
        date: dayString(new Date()),
        code: "database_unreachable",
        message: `Cannot read the database, so cache staleness was not checked: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    if (opts.json) {
      console.log(JSON.stringify({ checked_at: new Date().toISOString(), ok: findings.length === 0, findings }, null, 2));
    } else if (findings.length === 0) {
      console.log(`All clear: no problems in the last ${opts.days} day(s) (${dayString(new Date())}).`);
    } else {
      findings.forEach((f) => console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.domain} ${f.date} [${f.code}] ${f.message}`));
    }
    if (findings.some((f) => f.severity === "error")) process.exitCode = 1;
  });

travel
  .command("next-year")
  .description(
    `Print the next year the nightly backfill should catalog (${BACKFILL_START_YEAR} down to ${BACKFILL_END_YEAR}), ` +
      "or nothing once every year is done"
  )
  .action(async () => {
    const year = nextBackfillYear(path.join(getConfig().getBrainRoot(), "travel"));
    if (year !== null) console.log(year);
  });

const feature = program.command("feature").description("Manage feature-request proposals (written by the PM role) (proposed -> approved -> in-progress -> done)");

feature
  .command("list")
  .description("List feature-request proposals")
  .option("--domain <d>", "Only this domain (default: every registered domain)")
  .option("--status <s>", "Only this status: proposed | approved | in-progress | done")
  .action(async (opts: { domain?: string; status?: string }) => {
    const brainRoot = getConfig().getBrainRoot();
    const domains = opts.domain ? [opts.domain] : FEATURE_DOMAINS;
    const rows = domains.flatMap((d) => listProposals(brainRoot, d));
    const filtered = opts.status ? rows.filter((r) => r.status === opts.status) : rows;
    if (filtered.length === 0) {
      console.log("No feature-request proposals found.");
      return;
    }
    for (const p of filtered) {
      console.log(`${p.slug}  [${p.status}]  ${p.domain}  impact=${p.impact ?? "?"} effort=${p.effort ?? "?"}  ${p.title}`);
    }
  });

/** Finds a proposal by slug, searching every registered domain unless `domainHint` narrows it. Throws on an ambiguous match. */
function findProposalAnyDomain(
  brainRoot: string,
  slug: string,
  domainHint?: string
): { domain: string; file: string } | null {
  const domains = domainHint ? [domainHint] : FEATURE_DOMAINS;
  const matches = domains
    .map((domain) => ({ domain, proposal: findProposalBySlug(brainRoot, domain, slug) }))
    .filter((m): m is { domain: string; proposal: NonNullable<ReturnType<typeof findProposalBySlug>> } => m.proposal != null);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`"${slug}" exists in multiple domains (${matches.map((m) => m.domain).join(", ")}) — pass --domain to disambiguate`);
  }
  return { domain: matches[0].domain, file: matches[0].proposal.file };
}

function setStatusCommand(
  id: string,
  domainHint: string | undefined,
  status: ProposalStatus,
  label: string,
  requireCurrent?: ProposalStatus
): void {
  const brainRoot = getConfig().getBrainRoot();
  try {
    const found = findProposalAnyDomain(brainRoot, id, domainHint);
    if (!found) {
      console.error(`feature ${label}: no proposal found with id "${id}"`);
      process.exitCode = 1;
      return;
    }
    if (requireCurrent) {
      const current = readProposalFile(found.file)?.status;
      if (current !== requireCurrent) {
        console.error(`feature ${label}: "${id}" is ${current ?? "unreadable"}, not ${requireCurrent} — nothing changed`);
        process.exitCode = 1;
        return;
      }
    }
    setProposalStatus(found.file, status);
    console.log(`${found.domain}/${id}: -> ${status}`);
  } catch (e) {
    console.error(`feature ${label}: ${e}`);
    process.exitCode = 1;
  }
}

feature
  .command("approve <id>")
  .description("Mark a proposal approved (a human decision; nothing has started) — <id> is its filename without the .md extension (see `feature list`)")
  .option("--domain <d>", "Domain the id belongs to, if it's ambiguous across domains")
  .action(async (id: string, opts: { domain?: string }) => setStatusCommand(id, opts.domain, "approved", "approve"));

feature
  .command("start <id>")
  .description("Mark an approved proposal in-progress (run by whoever picks the work up, e.g. the eng skill) — refuses anything not currently approved")
  .option("--domain <d>", "Domain the id belongs to, if it's ambiguous across domains")
  .action(async (id: string, opts: { domain?: string }) => setStatusCommand(id, opts.domain, "in-progress", "start", "approved"));

feature
  .command("done <id>")
  .description("Mark a proposal done — <id> is its filename without the .md extension (see `feature list`)")
  .option("--domain <d>", "Domain the id belongs to, if it's ambiguous across domains")
  .action(async (id: string, opts: { domain?: string }) => setStatusCommand(id, opts.domain, "done", "done"));

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
