import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import { getConfig } from "../../core/config";
import { Db } from "../../core/db";
import { ValidationError } from "../../core/errors";
import { runPrompt } from "../../core/executor";
import type { Signal } from "../../core/models";
import { checkCacheStaleness, dayString } from "../../core/runCheck";
import { currentRunDir, readRunEvents } from "../../core/runLog";
import { buildRunReport, formatRunReportText } from "../../core/runReport";
import { writeVerified } from "../../core/safeWrite";
import { validateEnv } from "../../core/setup";
import { ApiHttpError, type ApiRoute, type CliContext, type DomainApiModule } from "../../core/api/types";
import { defaultReportsDir } from "./agents/equityAgent";
import { TraderAgent } from "./agents/traderAgent";
import { loadCacheAgeGetters, resolveTickerUniverse } from "./cliHelpers";
import { computeTickerDataQuality, loadDataQualityTolerances } from "./dataQuality";
import { DATA_REFRESH_TIERS, runDataRefresh, type DataRefreshTier } from "./dataRefresh";
import { equityDataFromCache } from "./fundamentalsCache";
import { financialRunExpectations, financialRunStatsTargets } from "./runExpectations";
import {
  checkThesisCoverageFindings,
  companyBrainPath,
  evaluateThesisCoverage,
  extractRecordedThesis,
  inspectTickerThesis,
} from "./thesisCoverage";
import { organizeStagedReports } from "./tools/reportOrganizer";
import {
  buildSignalsFromDir,
  collectEvaluationsFromDir,
  filterUnchangedSignals,
} from "./tools/signalBuilder";

const VALID_STRATEGIES = ["long-term", "swing", "both"] as const;

function asObject(val: unknown): Record<string, unknown> {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function normalizeTicker(raw: string): string {
  const ticker = raw.trim().toUpperCase();
  if (!/^[A-Z0-9._-]+$/.test(ticker) || ticker.includes("..")) {
    throw new ValidationError(`Invalid ticker "${raw}"`);
  }
  return ticker;
}

/**
 * Replace or insert the `## Your thesis` section inside a company brain markdown
 * file without losing surrounding frontmatter, status, or call-history sections.
 */
export function upsertThesisSection(existingMarkdown: string | null, ticker: string, thesisText: string): string {
  const formattedBlock = thesisText
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

  if (!existingMarkdown) {
    return [
      "---",
      `ticker: ${ticker}`,
      "---",
      "",
      `# ${ticker}`,
      "",
      "## Your thesis (compiled truth)",
      "",
      formattedBlock,
      "",
    ].join("\n");
  }

  const headingRe = /^(##\s+(?:your\s+)?thesis\b.*)$/im;
  const match = headingRe.exec(existingMarkdown);
  if (!match) {
    const trimmed = existingMarkdown.replace(/\s+$/, "");
    return `${trimmed}\n\n## Your thesis (compiled truth)\n\n${formattedBlock}\n`;
  }

  const sectionStart = match.index + match[0].length;
  const afterHeading = existingMarkdown.slice(sectionStart);
  const nextSectionMatch = /^##\s+/m.exec(afterHeading);
  const tail = nextSectionMatch ? afterHeading.slice(nextSectionMatch.index) : "";
  const prefix = existingMarkdown.slice(0, sectionStart);
  return `${prefix}\n\n${formattedBlock}\n${tail ? `\n${tail}` : ""}`;
}

const routes: ApiRoute[] = [
  // ── Positions ────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/api/domains/financial/positions",
    summary: "List all portfolio positions",
    handler: async () => {
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const positions = await db.getAllPositions();
        return { positions };
      } finally {
        await db.close();
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/financial/positions",
    summary: "Add or update a portfolio position",
    handler: async (req) => {
      const body = asObject(req.body);
      const ticker = normalizeTicker(String(body.ticker ?? ""));
      const shares = Number(body.shares);
      const costBasis = Number(body.costBasis ?? body.cost_basis);
      if (!Number.isFinite(shares) || !Number.isFinite(costBasis)) {
        throw new ValidationError("shares and cost_basis must be numbers");
      }
      const strategy = body.strategy !== undefined && body.strategy !== null ? String(body.strategy) : undefined;
      if (strategy && !(VALID_STRATEGIES as readonly string[]).includes(strategy)) {
        throw new ValidationError("--strategy must be one of: long-term, swing, both");
      }
      const notes = typeof body.notes === "string" ? body.notes : undefined;

      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        await db.addTicker(ticker, ticker, "PUBLIC");
        const ok = await db.addPosition(ticker, shares, costBasis, notes, strategy);
        return {
          status: 201,
          body: { ok, ticker, shares, costBasis, notes: notes ?? null, strategy: strategy ?? null },
        };
      } finally {
        await db.close();
      }
    },
  },
  {
    method: "PATCH",
    pattern: "/api/domains/financial/positions/:ticker/strategy",
    summary: "Update the strategy tag on an existing portfolio position",
    handler: async (req) => {
      const ticker = normalizeTicker(req.params.ticker);
      const body = asObject(req.body);
      const strategy = String(body.strategy ?? "");
      if (!(VALID_STRATEGIES as readonly string[]).includes(strategy)) {
        throw new ValidationError("strategy must be one of: long-term, swing, both");
      }
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const ok = await db.updatePositionStrategy(ticker, strategy);
        if (!ok) {
          throw new ApiHttpError("Position not found", 404, "not_found");
        }
        return { ok: true, ticker, strategy };
      } finally {
        await db.close();
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/domains/financial/positions/:ticker",
    summary: "Remove a portfolio position",
    handler: async (req) => {
      const ticker = normalizeTicker(req.params.ticker);
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const ok = await db.removePosition(ticker);
        if (!ok) {
          throw new ApiHttpError("Position not found", 404, "not_found");
        }
        return { ok: true, ticker };
      } finally {
        await db.close();
      }
    },
  },

  // ── Watchlist ────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/api/domains/financial/watchlist",
    summary: "List watchlist tickers and theses",
    handler: async () => {
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const items = await db.getWatchlist();
        return { watchlist: items };
      } finally {
        await db.close();
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/financial/watchlist",
    summary: "Add or update a ticker on the watchlist",
    handler: async (req) => {
      const body = asObject(req.body);
      const ticker = normalizeTicker(String(body.ticker ?? ""));
      const thesis = String(body.thesis ?? "").trim();
      if (!thesis) throw new ValidationError("thesis is required");
      const notes = typeof body.notes === "string" ? body.notes : undefined;

      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        await db.addTicker(ticker, ticker, "PUBLIC");
        const ok = await db.addWatchlist(ticker, thesis, notes);
        return {
          status: 201,
          body: { ok, ticker, thesis, notes: notes ?? null },
        };
      } finally {
        await db.close();
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/domains/financial/watchlist/:ticker",
    summary: "Remove a ticker from the watchlist",
    handler: async (req) => {
      const ticker = normalizeTicker(req.params.ticker);
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const ok = await db.removeWatchlist(ticker);
        if (!ok) {
          throw new ApiHttpError("Not found on watchlist", 404, "not_found");
        }
        return { ok: true, ticker };
      } finally {
        await db.close();
      }
    },
  },

  // ── Signals ──────────────────────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/api/domains/financial/signals",
    summary: "List recorded investment signals (optionally filtered by ticker and days)",
    handler: async (req) => {
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const ticker = req.query.ticker?.trim() ? normalizeTicker(req.query.ticker) : undefined;
        const days = Math.max(1, parseInt(req.query.days ?? "30", 10) || 30);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit ?? "50", 10) || 50));
        const signals = ticker ? await db.getSignals(ticker, days) : await db.getAllSignals(limit);
        return { signals };
      } finally {
        await db.close();
      }
    },
  },

  // ── Cached Data Dump & Tiered Refresh ────────────────────────────────────
  {
    method: "GET",
    pattern: "/api/domains/financial/data-dump",
    summary: "Return cached quote, Morningstar fundamentals, and data_quality flags for all tracked tickers",
    handler: async () => {
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const positions = await db.getAllPositions();
        const watchlist = await db.getWatchlist();
        const positionsByTicker = Object.fromEntries(positions.map((p) => [p.ticker, p]));
        const watchlistByTicker = Object.fromEntries(watchlist.map((w) => [w.ticker, w]));
        const allTickers = await resolveTickerUniverse(db);
        if (allTickers.length === 0) {
          return { items: [] };
        }
        const tolerances = loadDataQualityTolerances();
        const now = new Date();
        const items = await Promise.all(
          allTickers.map(async (ticker) => {
            const pos = positionsByTicker[ticker];
            const watch = watchlistByTicker[ticker];
            const [morningstarRow, finnhubRow, quote] = await Promise.all([
              db.getLatestFundamentals(ticker, "morningstar"),
              db.getLatestFundamentals(ticker, "finnhub"),
              db.getLatestQuote(ticker),
            ]);
            return {
              ticker,
              isPosition: !!pos,
              isWatchlist: !!watch,
              positionStrategyTag: pos?.strategy ?? null,
              shares: pos?.shares ?? null,
              costBasis: pos?.cost_basis ?? null,
              watchlistThesis: watch?.thesis ?? null,
              quote: quote ?? null,
              equity: morningstarRow ? equityDataFromCache(morningstarRow) : null,
              data_quality: computeTickerDataQuality({
                ticker,
                finnhub: finnhubRow,
                morningstar: morningstarRow,
                quote,
                position: pos,
                tolerances,
                now,
              }),
            };
          })
        );
        return { items };
      } finally {
        await db.close();
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/financial/data-refresh",
    summary: "Refresh cached quotes/technicals/fundamentals for positions+watchlist tickers by tier",
    handler: async (req) => {
      const body = asObject(req.body);
      const tier = String(body.tier ?? "");
      if (!DATA_REFRESH_TIERS.includes(tier as DataRefreshTier)) {
        throw new ValidationError(`Invalid --tier "${tier}" — expected one of: ${DATA_REFRESH_TIERS.join(", ")}`);
      }
      const tickersCsv =
        Array.isArray(body.tickers)
          ? body.tickers.map(String).join(",")
          : typeof body.tickers === "string"
            ? body.tickers
            : undefined;
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const { tickers, failed } = await runDataRefresh(tier as DataRefreshTier, tickersCsv, { config, db });
        return { tier, tickers, failed };
      } finally {
        await db.close();
      }
    },
  },

  // ── Company Theses in <brain> ────────────────────────────────────────────
  {
    method: "GET",
    pattern: "/api/domains/financial/theses",
    summary: "Evaluate company thesis coverage across portfolio+watchlist (or ?tickers=A,B)",
    handler: async (req) => {
      const config = getConfig();
      const brainRoot = config.getBrainRoot();
      let tickers: string[];
      if (req.query.tickers?.trim()) {
        tickers = req.query.tickers
          .split(",")
          .map((t) => normalizeTicker(t))
          .filter(Boolean);
      } else {
        const db = await Db.open(config.getDatabaseUrl());
        try {
          tickers = await resolveTickerUniverse(db);
        } finally {
          await db.close();
        }
      }
      return evaluateThesisCoverage(brainRoot, tickers);
    },
  },
  {
    method: "GET",
    pattern: "/api/domains/financial/theses/:ticker",
    summary: "Read a ticker's company brain markdown, extracted thesis, and Buffett research agenda",
    handler: (req) => {
      const ticker = normalizeTicker(req.params.ticker);
      const brainRoot = getConfig().getBrainRoot();
      const coverage = inspectTickerThesis(brainRoot, ticker);
      const content = fs.existsSync(coverage.filePath) ? fs.readFileSync(coverage.filePath, "utf8") : null;
      const extractedThesis = content ? extractRecordedThesis(content) : null;
      return {
        ...coverage,
        extractedThesis,
        content,
      };
    },
  },
  {
    method: "PUT",
    pattern: "/api/domains/financial/theses/:ticker",
    summary: "Create or update a ticker's thesis note in <brain>/financial/brain/investing/public/companies/<TICKER>.md",
    handler: (req) => {
      const ticker = normalizeTicker(req.params.ticker);
      const body = asObject(req.body);
      const brainRoot = getConfig().getBrainRoot();
      const filePath = companyBrainPath(brainRoot, ticker);
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;

      let nextMarkdown: string;
      if (typeof body.content === "string" && body.content.trim()) {
        nextMarkdown = body.content;
      } else if (typeof body.thesis === "string" && body.thesis.trim()) {
        nextMarkdown = upsertThesisSection(existing, ticker, body.thesis);
      } else {
        throw new ValidationError("Request body must include non-empty `thesis` or raw `content`");
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const problem = writeVerified(filePath, nextMarkdown);
      if (problem) {
        throw new ApiHttpError(`Failed to write thesis file: ${problem}`, 500, "write_verification_failed");
      }
      const coverage = inspectTickerThesis(brainRoot, ticker);
      return {
        ...coverage,
        extractedThesis: extractRecordedThesis(nextMarkdown),
      };
    },
  },

  // ── Reports & Signal Pipeline ────────────────────────────────────────────
  {
    method: "POST",
    pattern: "/api/domains/financial/reports/organize",
    summary: "Organize staged Morningstar PDFs into target/archive/error directories",
    handler: async (req) => {
      const body = asObject(req.body);
      const base = defaultReportsDir();
      const stagingDir = typeof body.stagingDir === "string" && body.stagingDir ? body.stagingDir : path.join(base, "staging");
      const targetDir = typeof body.targetDir === "string" && body.targetDir ? body.targetDir : base;
      const archiveDir = typeof body.archiveDir === "string" && body.archiveDir ? body.archiveDir : path.join(base, "archive");
      const errorDir = typeof body.errorDir === "string" && body.errorDir ? body.errorDir : path.join(base, "error");
      const result = await organizeStagedReports(stagingDir, targetDir, archiveDir, errorDir);
      return result;
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/financial/signals/build",
    summary: "Deterministically build notify-ready signals from VERDICT lines in a run directory",
    handler: async (req) => {
      const body = asObject(req.body);
      const dir = String(body.dir ?? "").trim();
      if (!dir || !fs.existsSync(dir)) {
        throw new ApiHttpError(`Directory not found: ${dir}`, 404, "not_found");
      }
      const onlyChanged = Boolean(body.onlyChanged);
      const dryRun = Boolean(body.dryRun);
      const confidenceMove = body.confidenceMove !== undefined ? Number(body.confidenceMove) : 0.1;

      const config = getConfig();
      const brainRoot = config.getBrainRoot();
      const companiesDir = path.join(brainRoot, "financial", "brain", "investing", "public", "companies");
      const result = buildSignalsFromDir(dir, fs.existsSync(companiesDir) ? { brainRoot } : undefined);
      const evaluations = dryRun ? [] : collectEvaluationsFromDir(dir);
      let signals = result.signals;
      let unchangedCount = 0;

      const dbUrl = config.getDatabaseUrl();
      if (onlyChanged || (!dryRun && evaluations.length > 0 && dbUrl)) {
        const db = await Db.open(dbUrl);
        try {
          if (onlyChanged) {
            const filtered = await filterUnchangedSignals(db, result.signals, confidenceMove);
            signals = filtered.changed;
            unchangedCount = filtered.unchanged.length;
          }
          if (!dryRun && evaluations.length > 0) {
            const runAt = new Date().toISOString();
            for (const ev of evaluations) {
              let { rsi, price } = ev;
              if (rsi == null || price == null) {
                const q = await db.getLatestQuote(ev.ticker);
                if (rsi == null) rsi = q?.rsi ?? null;
                if (price == null) price = q?.close ?? null;
              }
              await db.recordGateRun({
                ticker: ev.ticker,
                skill: ev.skill,
                runAt,
                verdict: ev.verdict,
                rsi,
                price,
              });
            }
          }
        } finally {
          await db.close();
        }
      }

      return {
        signals,
        noSignal: result.noSignal,
        errors: result.errors,
        unchangedCount,
      };
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/financial/signals/distill",
    summary: "Distill a directory of run-skill markdown write-ups into a signals array via a single cheap model call",
    handler: async (req) => {
      const body = asObject(req.body);
      const dir = String(body.dir ?? "").trim();
      if (!validateEnv()) {
        throw new ApiHttpError("Environment validation failed", 400, "invalid_env");
      }
      if (!dir || !fs.existsSync(dir)) {
        throw new ApiHttpError(`Directory not found: ${dir}`, 404, "not_found");
      }
      const files = fs
        .readdirSync(dir)
        .filter(
          (f) =>
            f.endsWith("-long-term-quality.md") ||
            f.endsWith("-swing-trading-large-cap.md") ||
            f.endsWith("-buffett-value.md")
        );
      if (files.length === 0) {
        throw new ValidationError(
          `No *-long-term-quality.md, *-swing-trading-large-cap.md, or *-buffett-value.md files found in ${dir}`
        );
      }

      const watchlistTickers = new Set<string>();
      const dumpPath = path.join(dir, "data-dump.json");
      if (fs.existsSync(dumpPath)) {
        try {
          const raw = fs.readFileSync(dumpPath, "utf8");
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
        } catch {
          // non-fatal warning in legacy CLI
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

      const config = getConfig();
      const { output } = await runPrompt(config.getExecutorApiKey(), systemPrompt, userPrompt, {
        tier: "cheap",
        maxTokens: 8000,
        label: "financial/distill-signals",
      });
      const cleaned = output
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) throw new Error("not an array");
      } catch (e) {
        throw new ApiHttpError(`Model output was not valid JSON: ${e}`, 502, "bad_output", { output });
      }
      return { signals: parsed };
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/financial/notify",
    summary: "Send a batch signal notification email and persist signals to history",
    handler: async (req) => {
      const body = asObject(req.body);
      if (!Array.isArray(body.signals)) {
        throw new ValidationError("Request body must include `signals` array");
      }
      const dryRun = Boolean(body.dryRun);
      const rawSignals = body.signals as Array<{
        ticker: string;
        recommendation: "BUY" | "SELL" | "HOLD";
        confidence: number;
        reasoning: string;
        fromWatchlist?: boolean;
      }>;

      if (dryRun) {
        const tally = (r: string) => rawSignals.filter((s) => s.recommendation === r).length;
        return {
          dryRun: true,
          sent: false,
          count: rawSignals.length,
          counts: { BUY: tally("BUY"), SELL: tally("SELL"), HOLD: tally("HOLD") },
          signals: rawSignals,
        };
      }

      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const signals: Signal[] = rawSignals.map((s) => ({
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
        const runDir = typeof body.runDir === "string" && body.runDir ? body.runDir : currentRunDir();
        const events = runDir ? readRunEvents(runDir) : [];
        const ok = await trader.sendBatchEmail(
          signals,
          {},
          {},
          undefined,
          events.length ? buildRunReport(events) : undefined
        );
        if (!ok) {
          throw new ApiHttpError("Email failed (signals not recorded)", 502, "email_failed");
        }
        return { dryRun: false, sent: true, count: signals.length };
      } finally {
        await db.close();
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/financial/notify-summary",
    summary: "Email a deterministic run summary (or preview with dryRun) from a run directory's run.jsonl",
    handler: async (req) => {
      const body = asObject(req.body);
      const dir = String(body.dir ?? "").trim();
      const dryRun = Boolean(body.dryRun);
      const events = readRunEvents(dir);
      if (events.length === 0) {
        throw new ApiHttpError(`notify-summary: no run events found in ${dir}`, 404, "not_found");
      }
      const report = buildRunReport(events);
      const text = formatRunReportText(report);
      if (dryRun) {
        return {
          dryRun: true,
          sent: false,
          kind: report.status === "failed" ? "run-problems" : "no-changes",
          report,
          text,
        };
      }
      const config = getConfig();
      const db = await Db.open(config.getDatabaseUrl());
      try {
        const trader = new TraderAgent(
          db,
          config.getGmailAddress(),
          config.getGmailAppPassword(),
          config.getNotificationEmail()
        );
        const ok = await trader.sendRunSummaryEmail(report);
        if (!ok) {
          throw new ApiHttpError("Run summary email failed", 502, "email_failed");
        }
        return { dryRun: false, sent: true, report, text };
      } finally {
        await db.close();
      }
    },
  },
];

function registerCli(program: Command, ctx: CliContext): void {
  // ── Position management ──────────────────────────────────────────────────
  const position = program.command("position").description("Manage portfolio positions");

  position
    .command("add <ticker> <shares> <cost_basis>")
    .description("Add or update a portfolio position")
    .option("-n, --notes <notes>", "Position notes")
    .option(
      "-s, --strategy <strategy>",
      "Strategy this position is held under: long-term, swing, or both (default: long-term, or whatever it already was on update)"
    )
    .action(async (ticker: string, sharesStr: string, costBasisStr: string, opts: { notes?: string; strategy?: string }) => {
      const shares = parseFloat(sharesStr);
      const costBasis = parseFloat(costBasisStr);
      if (isNaN(shares) || isNaN(costBasis)) {
        console.error("shares and cost_basis must be numbers");
        process.exitCode = 1;
        return;
      }
      if (opts.strategy && !(VALID_STRATEGIES as readonly string[]).includes(opts.strategy)) {
        console.error("--strategy must be one of: long-term, swing, both");
        process.exitCode = 1;
        return;
      }
      const res = await ctx.getClient().post<{ ok: boolean; ticker: string }>(
        "/api/domains/financial/positions",
        { ticker, shares, costBasis, notes: opts.notes, strategy: opts.strategy }
      );
      ctx.output(res, () => {
        console.log(res.ok ? `Position added: ${res.ticker}` : "Failed to add position");
      });
    });

  position
    .command("strategy <ticker> <strategy>")
    .description("Set the strategy tag on an existing position without touching shares/cost basis (long-term, swing, or both)")
    .action(async (ticker: string, strategy: string) => {
      if (!(VALID_STRATEGIES as readonly string[]).includes(strategy)) {
        console.error("strategy must be one of: long-term, swing, both");
        process.exitCode = 1;
        return;
      }
      try {
        const res = await ctx.getClient().patch<{ ok: boolean; ticker: string; strategy: string }>(
          `/api/domains/financial/positions/${encodeURIComponent(ticker)}/strategy`,
          { strategy }
        );
        ctx.output(res, () => {
          console.log(`Strategy set: ${res.ticker} -> ${res.strategy}`);
        });
      } catch (e) {
        if (e instanceof ApiHttpError && e.status === 404) {
          ctx.output({ ok: false, error: "Position not found" }, () => console.log("Position not found"));
          return;
        }
        throw e;
      }
    });

  position
    .command("remove <ticker>")
    .description("Remove a portfolio position")
    .action(async (ticker: string) => {
      try {
        const res = await ctx.getClient().delete<{ ok: boolean; ticker: string }>(
          `/api/domains/financial/positions/${encodeURIComponent(ticker)}`
        );
        ctx.output(res, () => {
          console.log(`Position removed: ${res.ticker}`);
        });
      } catch (e) {
        if (e instanceof ApiHttpError && e.status === 404) {
          ctx.output({ ok: false, error: "Position not found" }, () => console.log("Position not found"));
          return;
        }
        throw e;
      }
    });

  position
    .command("list")
    .description("List all positions")
    .action(async () => {
      const res = await ctx.getClient().get<{
        positions: Array<{ ticker: string; shares: number; cost_basis: number; strategy: string; notes: string | null }>;
      }>("/api/domains/financial/positions");
      ctx.output(res, () => {
        if (res.positions.length === 0) {
          console.log("No positions");
        } else {
          console.log("\nPositions:");
          console.log("-".repeat(60));
          res.positions.forEach((p) => {
            console.log(
              `  ${p.ticker.padEnd(8)} ${p.shares} shares @ $${p.cost_basis.toFixed(2)}  [${p.strategy}]`
            );
            if (p.notes) console.log(`           ${p.notes}`);
          });
        }
      });
    });

  // ── Watchlist management ─────────────────────────────────────────────────
  const watchlist = program.command("watchlist").description("Manage watchlist");

  watchlist
    .command("add <ticker> <thesis>")
    .description("Add ticker to watchlist")
    .option("-n, --notes <notes>", "Additional notes")
    .action(async (ticker: string, thesis: string, opts: { notes?: string }) => {
      const res = await ctx.getClient().post<{ ok: boolean; ticker: string }>(
        "/api/domains/financial/watchlist",
        { ticker, thesis, notes: opts.notes }
      );
      ctx.output(res, () => {
        console.log(res.ok ? `Watchlist added: ${res.ticker}` : "Failed to add watchlist item");
      });
    });

  watchlist
    .command("remove <ticker>")
    .description("Remove from watchlist")
    .action(async (ticker: string) => {
      try {
        const res = await ctx.getClient().delete<{ ok: boolean; ticker: string }>(
          `/api/domains/financial/watchlist/${encodeURIComponent(ticker)}`
        );
        ctx.output(res, () => {
          console.log(`Removed: ${res.ticker}`);
        });
      } catch (e) {
        if (e instanceof ApiHttpError && e.status === 404) {
          ctx.output({ ok: false, error: "Not found on watchlist" }, () => console.log("Not found on watchlist"));
          return;
        }
        throw e;
      }
    });

  watchlist
    .command("list")
    .description("List watchlist")
    .action(async () => {
      const res = await ctx.getClient().get<{
        watchlist: Array<{ ticker: string; thesis: string; notes: string | null }>;
      }>("/api/domains/financial/watchlist");
      ctx.output(res, () => {
        if (res.watchlist.length === 0) {
          console.log("Watchlist is empty");
        } else {
          console.log("\nWatchlist:");
          console.log("-".repeat(60));
          res.watchlist.forEach((w) => {
            console.log(`  ${w.ticker.padEnd(8)} ${w.thesis}`);
            if (w.notes) console.log(`           ${w.notes}`);
          });
        }
      });
    });

  // ── Company thesis brain ─────────────────────────────────────────────────
  const thesis = program.command("thesis").description("Inspect or update company thesis notes in <brain>");

  thesis
    .command("list")
    .description("List thesis coverage across portfolio and watchlist tickers")
    .option("--tickers <list>", "Optional comma-separated ticker subset")
    .action(async (opts: { tickers?: string }) => {
      const res = await ctx.getClient().get<{
        total: number;
        covered: string[];
        missingFile: string[];
        emptyThesis: string[];
        items: Array<{ ticker: string; status: string; filePath: string }>;
      }>("/api/domains/financial/theses", { tickers: opts.tickers });
      ctx.output(res, () => {
        if (res.total === 0) {
          console.log("No tracked tickers.");
          return;
        }
        console.log(`Thesis coverage: ${res.covered.length}/${res.total} covered`);
        res.items.forEach((item) => {
          console.log(`  ${item.ticker.padEnd(8)} [${item.status}]  ${item.filePath}`);
        });
      });
    });

  thesis
    .command("show <ticker>")
    .description("Show a ticker's recorded thesis (or Buffett research checklist if uncovered)")
    .action(async (ticker: string) => {
      const res = await ctx.getClient().get<{
        ticker: string;
        status: string;
        hasThesis: boolean;
        filePath: string;
        extractedThesis: string | null;
        content: string | null;
        researchAreas: Array<{ title: string; whatBuffettWouldDo: string }>;
      }>(`/api/domains/financial/theses/${encodeURIComponent(ticker)}`);
      ctx.output(res, () => {
        console.log(`${res.ticker} [${res.status}] — ${res.filePath}`);
        if (res.extractedThesis) {
          console.log(`\n${res.extractedThesis}`);
        } else {
          console.log("\nNo thesis recorded yet. Suggested research areas:");
          res.researchAreas.forEach((r) => console.log(`- ${r.title}: ${r.whatBuffettWouldDo}`));
        }
      });
    });

  thesis
    .command("set <ticker> [text]")
    .description("Update a ticker's `## Your thesis` section (or replace full markdown with --file)")
    .option("--file <path>", "Write raw markdown from this file")
    .action(async (ticker: string, text: string | undefined, opts: { file?: string }) => {
      const payload = opts.file
        ? { content: fs.readFileSync(opts.file, "utf8") }
        : { thesis: text ?? "" };
      const res = await ctx.getClient().put<{ ticker: string; status: string; filePath: string }>(
        `/api/domains/financial/theses/${encodeURIComponent(ticker)}`,
        payload
      );
      ctx.output(res, () => {
        console.log(`Thesis saved for ${res.ticker} [${res.status}]: ${res.filePath}`);
      });
    });

  // ── Report organization ──────────────────────────────────────────────────
  program
    .command("organize-reports")
    .description("Organize Morningstar PDFs from staging")
    .option("--staging-dir <dir>", "Staging directory", path.join(defaultReportsDir(), "staging"))
    .option("--target-dir <dir>", "Target reports directory", defaultReportsDir())
    .option("--archive-dir <dir>", "Archive directory", path.join(defaultReportsDir(), "archive"))
    .option("--error-dir <dir>", "Error directory", path.join(defaultReportsDir(), "error"))
    .action(
      async (opts: { stagingDir: string; targetDir: string; archiveDir: string; errorDir: string }) => {
        const res = await ctx.getClient().post<{ failed: string[]; processed: string[] }>(
          "/api/domains/financial/reports/organize",
          opts
        );
        if (ctx.isJson()) {
          console.log(JSON.stringify(res, null, 2));
        }
        if (res.failed.length) process.exitCode = 1;
      }
    );

  // ── Signals ──────────────────────────────────────────────────────────────
  program
    .command("signals [ticker]")
    .description("Show recent signals (optionally filtered by ticker)")
    .option("-d, --days <days>", "Number of days to look back", "30")
    .action(async (ticker: string | undefined, opts: { days: string }) => {
      const res = await ctx.getClient().get<{
        signals: Array<{ date: string; ticker: string; recommendation: string; confidence: number; reasoning: string }>;
      }>("/api/domains/financial/signals", {
        ticker,
        days: parseInt(opts.days, 10),
      });
      ctx.output(res, () => {
        if (res.signals.length === 0) {
          console.log("No signals found");
        } else {
          console.log(`\nSignals (${res.signals.length}):`);
          console.log("-".repeat(80));
          res.signals.forEach((s) => {
            console.log(
              `  ${s.date.split("T")[0]}  ${s.ticker.padEnd(8)} ${s.recommendation.padEnd(6)} ` +
                `${(s.confidence * 100).toFixed(0)}%  ${s.reasoning}`
            );
          });
        }
      });
    });

  // ── Data dump & tiered refresh ───────────────────────────────────────────
  program
    .command("data-dump")
    .description(
      "Print cached quote + fundamentals data for all positions/watchlist tickers as JSON — a pure " +
        "reporting view over what `data-refresh` last wrote, with no Finnhub/Morningstar calls of its " +
        "own."
    )
    .action(async () => {
      const res = await ctx.getClient().get<{ items: unknown[] }>("/api/domains/financial/data-dump");
      // Historically `data-dump` always prints a bare JSON array so cron scripts can parse it directly.
      console.log(res.items.length === 0 ? JSON.stringify([]) : JSON.stringify(res.items, null, 2));
    });

  program
    .command("data-refresh")
    .description(
      "Refresh cached quote/technicals/fundamentals for positions+watchlist tickers, scoped by tier. " +
        "intraday: quote + RSI/MA only (skips Finnhub fundamentals). " +
        "daily: quote + RSI/MA + Finnhub live fundamentals. " +
        "weekly: Morningstar PDF re-parse only."
    )
    .requiredOption("--tier <tier>", "intraday | daily | weekly")
    .option("--tickers <list>", "comma-separated subset; default: all positions+watchlist")
    .action(async (opts: { tier: string; tickers?: string }) => {
      if (!DATA_REFRESH_TIERS.includes(opts.tier as DataRefreshTier)) {
        console.error(`Invalid --tier "${opts.tier}" — expected one of: ${DATA_REFRESH_TIERS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const res = await ctx.getClient().post<{ tier: string; tickers: string[]; failed: string[] }>(
        "/api/domains/financial/data-refresh",
        { tier: opts.tier, tickers: opts.tickers }
      );
      if (res.failed.length > 0) {
        console.error(
          `data-refresh ${res.tier}: ${res.failed.length}/${res.tickers.length} ticker(s) failed: ${res.failed.join(", ")}`
        );
      }
      ctx.output(res, () => {
        if (res.tickers.length === 0) {
          console.log("No tickers to refresh (no positions/watchlist entries, and no --tickers given).");
          return;
        }
        console.log(`Refreshed ${res.tier} tier for ${res.tickers.length} ticker(s): ${res.tickers.join(", ")}`);
      });
    });

  // ── Distill / Build / Notify ─────────────────────────────────────────────
  program
    .command("distill-signals")
    .description(
      "[No longer used by daily-analysis.sh — see build-signals] Turn a directory of run-skill output files into a notify-ready signals JSON array, via a single Claude call."
    )
    .requiredOption("--dir <path>", "Directory containing run-skill output files (and optionally data-dump.json)")
    .action(async (opts: { dir: string }) => {
      const res = await ctx.getClient().post<{ signals: unknown[] }>(
        "/api/domains/financial/signals/distill",
        { dir: opts.dir }
      );
      console.log(JSON.stringify(res.signals, null, 2));
    });

  program
    .command("notify-summary")
    .description(
      'Email a run summary built from the run\'s logs, for runs with no new recommendations ("no changes today") or that didn\'t complete cleanly ("run had problems"). Deterministic, no model call.'
    )
    .requiredOption("--dir <path>", "Run directory containing run.jsonl")
    .option("--dry-run", "Print the summary instead of emailing it")
    .action(async (opts: { dir: string; dryRun?: boolean }) => {
      const res = await ctx.getClient().post<{
        dryRun: boolean;
        sent: boolean;
        kind?: string;
        text: string;
      }>("/api/domains/financial/notify-summary", { dir: opts.dir, dryRun: Boolean(opts.dryRun) });
      ctx.output(res, () => {
        if (res.dryRun) {
          console.log(`[dry-run] Would email a ${res.kind} summary:\n`);
          console.log(res.text);
        } else {
          console.log(res.sent ? "Run summary email sent" : "Run summary email failed");
        }
      });
    });

  program
    .command("build-signals")
    .description(
      "Build the notify-ready signals array from a run directory by reading each skill write-up's trailing `VERDICT:` line. Deterministic, no model call."
    )
    .requiredOption(
      "--dir <path>",
      "Run directory containing *-long-term-quality.md / *-swing-trading-large-cap.md / *-buffett-value.md files"
    )
    .option(
      "--only-changed",
      "Drop any signal whose recommendation matches the last one recorded for that ticker+strategy and whose confidence hasn't moved by --confidence-move"
    )
    .option(
      "--confidence-move <pct>",
      "With --only-changed: still treat a same-recommendation signal as changed if confidence moved at least this much (0-1)",
      "0.1"
    )
    .option("--dry-run", "Do not persist gate_runs records to the database")
    .action(async (opts: { dir: string; onlyChanged?: boolean; confidenceMove: string; dryRun?: boolean }) => {
      const res = await ctx.getClient().post<{
        signals: unknown[];
        noSignal: string[];
        errors: string[];
        unchangedCount: number;
      }>("/api/domains/financial/signals/build", {
        dir: opts.dir,
        onlyChanged: Boolean(opts.onlyChanged),
        confidenceMove: parseFloat(opts.confidenceMove),
        dryRun: Boolean(opts.dryRun),
      });
      console.log(JSON.stringify(res.signals, null, 2));
      console.error(
        `build-signals: ${res.signals.length} signals, ${res.noSignal.length} with nothing to report, ${res.errors.length} errors` +
          (opts.onlyChanged ? `, ${res.unchangedCount} unchanged from last time (dropped)` : "")
      );
      res.errors.forEach((e) => console.error(`  ERROR ${e}`));
      if (res.errors.length > 0) process.exitCode = 1;
    });

  program
    .command("notify")
    .description(
      "Send a batch email for a set of signals and record them in signal history. Deterministic — takes already-decided recommendations, does no judgment itself."
    )
    .option(
      "--file <path>",
      "Path to a JSON file with an array of {ticker, recommendation, confidence, reasoning, fromWatchlist?}. Reads stdin if omitted."
    )
    .option("--dry-run", "Print what would be sent and exit — no email, nothing recorded in the signals table")
    .option("--run-dir <dir>", "Append a summary of this run (from its run.jsonl) to the email; defaults to $SNESTACK_RUN_DIR")
    .action(async (opts: { file?: string; dryRun?: boolean; runDir?: string }) => {
      const raw = opts.file ? fs.readFileSync(opts.file, "utf8") : fs.readFileSync(0, "utf8");
      const signals = JSON.parse(raw) as unknown[];
      const res = await ctx.getClient().post<{
        dryRun: boolean;
        sent: boolean;
        count: number;
        counts?: { BUY: number; SELL: number; HOLD: number };
        signals?: Array<{ ticker: string; recommendation: string; confidence: number }>;
      }>("/api/domains/financial/notify", {
        signals,
        dryRun: Boolean(opts.dryRun),
        runDir: opts.runDir,
      });
      ctx.output(res, () => {
        if (res.dryRun && res.counts && res.signals) {
          console.log(
            `[dry-run] Would email ${res.count} signals (${res.counts.BUY} BUY, ${res.counts.SELL} SELL, ${res.counts.HOLD} HOLD); nothing sent or recorded.`
          );
          res.signals.forEach((s) =>
            console.log(`  ${s.ticker.padEnd(6)} ${s.recommendation.padEnd(5)} ${s.confidence}`)
          );
        } else {
          console.log(res.sent ? `Email sent: ${res.count} signals` : "Email failed (signals not recorded)");
        }
      });
    });
}

export const domainApi: DomainApiModule = {
  routes,
  registerCli,
  healthHooks: {
    getExpectations: (brainRoot) => financialRunExpectations(brainRoot),
    getStatsTargets: (brainRoot) => financialRunStatsTargets(brainRoot),
    checkHealth: async ({ now, brainRoot }) => {
      const config = getConfig();
      try {
        const db = await Db.open(config.getDatabaseUrl());
        try {
          const tickers = await resolveTickerUniverse(db);
          return [
            ...checkCacheStaleness({ now, tickers, ...(await loadCacheAgeGetters(db, tickers)) }),
            ...checkThesisCoverageFindings({ now, brainRoot, tickers }),
          ];
        } finally {
          await db.close();
        }
      } catch (e) {
        return [
          {
            severity: "error",
            domain: "financial",
            date: dayString(now),
            code: "database_unreachable",
            message: `Cannot read the database, so cache staleness was not checked: ${e instanceof Error ? e.message : String(e)}`,
          },
        ];
      }
    },
  },
};
