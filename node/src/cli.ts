#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { getConfig } from "./core/config";
import { setupInteractive, validateEnv } from "./core/setup";
import { organizeStagedReports } from "./domains/financial/tools/reportOrganizer";
import { Db } from "./core/db";
import { runSkill, assembleSkillPrompt } from "./core/runSkill";
import { runPrompt } from "./core/executor";
import { authorizeGoogleCalendar } from "./domains/calendar/setup";
import { authorizeGmail } from "./domains/travel/setup";
import { parseMultiFileOutput, writeStagedCatalogFiles } from "./domains/travel/tools/fileWriter";
import { QuoteAgent } from "./domains/financial/agents/quoteAgent";
import { EquityAgent, defaultReportsDir } from "./domains/financial/agents/equityAgent";
import { TraderAgent } from "./domains/financial/agents/traderAgent";
import type { Signal } from "./core/models";

const program = new Command();

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

// ── Data dump for a Claude-driven analysis (deterministic only, no model call) ─
// This is the "fat code" half of the thin-harness/fat-skills split: it fetches
// and computes numbers (quotes, technicals, Morningstar fundamentals) and does
// no judgment. A Claude session reads this JSON plus domains/financial/skills/
// and the shared brain/ (~/Documents/personal-brain/financial/brain/) and does
// the actual BUY/SELL/HOLD reasoning — see domains/financial/skills/INDEX.md.

program
  .command("data-dump")
  .description(
    "Dump quote + fundamentals data for all positions/watchlist tickers as JSON. " +
      "No Claude call — purely deterministic data for an external judgment step to consume."
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
  .action(async (domain: string, skill: string, subject: string) => {
    if (!validateEnv()) {
      process.exitCode = 1;
      return;
    }
    try {
      const result = await runSkill(domain, skill, subject);
      console.log(`\n=== ${result.domain}/${result.skill} — ${result.subject} ===\n`);
      console.log(result.output);
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
  .action(async (year: string) => {
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
      const written = writeStagedCatalogFiles(getConfig().getBrainRoot(), parseInt(year, 10), files);
      console.log(`Wrote ${written.length} file(s) to the .nightly-draft/ staging directory:`);
      written.forEach((p) => console.log(`  ${p}`));
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
    "Turn a directory of run-skill output files into a notify-ready signals JSON array, " +
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

    const { output } = await runPrompt(config.getClaudeApiKey(), systemPrompt, userPrompt, {
      tier: "cheap",
      maxTokens: 8000,
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
      console.log(ok ? `Email sent: ${signals.length} signals` : "Email failed (signals not recorded)");
      if (!ok) process.exitCode = 1;
    } finally {
      db.close();
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
