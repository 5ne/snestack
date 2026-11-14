import * as fs from "fs";
import * as path from "path";
import { Config, getConfig, MODEL_TIERS, type ModelTier } from "../config";
import {
  defaultNodeDir,
  getDomainScriptsDir,
  listAllDomainScripts,
  listDomainReferences,
  listDomainScripts,
  listDomainSkills,
  listRegisteredDomains,
  loadAllDomainApis,
  loadContextTools,
  loadDomainSkillDetail,
  readDomainReference,
  writeDomainReference,
} from "../domainRegistry";
import { ValidationError } from "../errors";
import { runPrompt } from "../executor";
import {
  checkStaleDryRuns,
  dayString,
  evaluateRuns,
  readSummary,
  type Finding,
  type RunExpectation,
} from "../runCheck";
import {
  currentRunDir,
  extractErrorSummary,
  finalizeRun,
  logRunEvent,
  readRunEvents,
  type RunSummary,
} from "../runLog";
import { buildRunReport, formatRunReportText } from "../runReport";
import { assembleSkillPrompt, evaluateSkillGate, runSkill } from "../runSkill";
import { computeRunStats, formatRunStats, type RunStatsTarget } from "../runStats";
import { writeVerified } from "../safeWrite";
import { validateEnv } from "../setup";
import { ApiHttpError, type ApiRoute } from "./types";
import type { ApiRouter } from "./router";

export interface RecentRunRecord {
  domain: string;
  script: string;
  date: string;
  dir: string;
  summary: RunSummary;
}

function asObject(val: unknown): Record<string, unknown> {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function collectRecentRuns(
  targets: RunStatsTarget[],
  opts: { domain?: string; script?: string; includeDryRun?: boolean; limit: number }
): RecentRunRecord[] {
  const items: Array<RecentRunRecord & { sortKey: string }> = [];

  for (const target of targets) {
    if (opts.domain && target.domain !== opts.domain) continue;
    if (opts.script && target.script !== opts.script) continue;
    if (!fs.existsSync(target.runsRoot)) continue;

    for (const entry of fs.readdirSync(target.runsRoot)) {
      const isDryRunDir = entry.endsWith("-dryrun");
      if (isDryRunDir && !opts.includeDryRun) continue;
      if (!/^\d{4}-\d{2}-\d{2}(?:-dryrun)?$/.test(entry)) continue;
      const dayDir = path.join(target.runsRoot, entry);
      if (!fs.statSync(dayDir).isDirectory()) continue;

      const addRun = (dir: string, subKey: string) => {
        const summary = readSummary(dir);
        if (!summary) return;
        if (summary.dry_run && !opts.includeDryRun) return;
        items.push({
          domain: target.domain,
          script: summary.script ?? target.script,
          date: entry.slice(0, 10),
          dir,
          summary,
          sortKey: `${entry} ${subKey} ${summary.started_at ?? ""}`,
        });
      };

      if (fs.existsSync(path.join(dayDir, "run.json"))) {
        addRun(dayDir, "");
        continue;
      }
      for (const sub of fs.readdirSync(dayDir).sort()) {
        const subDir = path.join(dayDir, sub);
        if (fs.statSync(subDir).isDirectory() && fs.existsSync(path.join(subDir, "run.json"))) {
          addRun(subDir, sub);
        }
      }
    }
  }

  items.sort((a, b) => (a.sortKey > b.sortKey ? -1 : a.sortKey < b.sortKey ? 1 : 0));
  return items.slice(0, opts.limit).map(({ sortKey: _s, ...rest }) => rest);
}

export function buildCoreRoutes(getRouter: () => ApiRouter): ApiRoute[] {
  return [
    {
      method: "GET",
      pattern: "/api/health",
      summary: "Server health, version, and registered domains",
      handler: (req) => {
        const config = getConfig();
        const headerFlag = req.headers["x-snestack-auth-required"];
        const authRequired =
          headerFlag !== undefined ? headerFlag === "1" : Boolean(config.getApiToken());
        return {
          status: "ok",
          version: "1.0.0",
          domains: listRegisteredDomains(),
          authRequired,
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/routes",
      summary: "List all registered HTTP API routes across core and domains",
      handler: (req) => {
        const scope = req.query.scope;
        const all = getRouter().listRoutes();
        const routes = scope ? all.filter((r) => r.scope === scope) : all;
        return { count: routes.length, routes };
      },
    },
    {
      method: "GET",
      pattern: "/api/env",
      summary: "Non-secret configuration and environment readiness check",
      handler: () => {
        const config = getConfig();
        const missingRequired: string[] = [];
        const check = (name: string, fn: () => unknown) => {
          try {
            fn();
            return true;
          } catch {
            missingRequired.push(name);
            return false;
          }
        };

        const finnhubOk = check(Config.FINNHUB_API_KEY, () => config.getFinnhubApiKey());
        const claudeNeeded = config.getExecutorBackend() === "api";
        const claudeOk = claudeNeeded
          ? check(Config.CLAUDE_API_KEY, () => config.getClaudeApiKey())
          : Boolean(Config.get(Config.CLAUDE_API_KEY));
        const gmailOk = check(Config.GMAIL_ADDRESS, () => config.getGmailAddress());
        const notifyOk = check(Config.NOTIFICATION_EMAIL, () => config.getNotificationEmail());
        const brainRoot = config.getBrainRoot();

        return {
          valid: missingRequired.length === 0,
          missingRequired,
          executorChain: config.getExecutorChainDisplay(),
          brainRoot,
          brainRootExists: fs.existsSync(brainRoot),
          configured: {
            databaseUrl: Boolean(Config.get(Config.DATABASE_URL)),
            finnhubApiKey: finnhubOk,
            twelveDataApiKey: Boolean(Config.get(Config.TWELVEDATA_API_KEY)),
            claudeApiKey: claudeOk,
            gmailAddress: gmailOk,
            gmailAppPassword: Boolean(Config.get(Config.GMAIL_APP_PASSWORD)),
            notificationEmail: notifyOk,
            apiToken: Boolean(config.getApiToken()),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/domains",
      summary: "List registered domains with their skills, references, context tools, and scripts",
      handler: async () => {
        const domains = await Promise.all(
          listRegisteredDomains().map(async (domain) => {
            const tools = await loadContextTools(domain);
            return {
              name: domain,
              skills: listDomainSkills(domain),
              references: listDomainReferences(domain),
              contextTools: Object.keys(tools).sort(),
              scripts: listDomainScripts(domain),
            };
          })
        );
        return { domains };
      },
    },
    {
      method: "GET",
      pattern: "/api/domains/:domain/skills",
      summary: "List skills in a domain (pass ?all=true to include vision/pm/eng/INDEX docs)",
      handler: (req) => {
        const includeDocs = req.query.all === "true" || req.query.all === "1";
        const skills = listDomainSkills(req.params.domain, { includeDocs });
        return { domain: req.params.domain, skills };
      },
    },
    {
      method: "GET",
      pattern: "/api/domains/:domain/skills/:skill",
      summary: "Inspect a skill's frontmatter, markdown body, and referenced threshold files",
      handler: (req) => {
        return loadDomainSkillDetail(req.params.domain, req.params.skill);
      },
    },
    {
      method: "GET",
      pattern: "/api/domains/:domain/references",
      summary: "List shared reference markdown files in a domain",
      handler: (req) => {
        const references = listDomainReferences(req.params.domain);
        return { domain: req.params.domain, references };
      },
    },
    {
      method: "GET",
      pattern: "/api/domains/:domain/references/:ref",
      summary: "Read a domain reference markdown file (e.g. quality-bar)",
      handler: (req) => {
        return readDomainReference(req.params.domain, req.params.ref);
      },
    },
    {
      method: "PUT",
      pattern: "/api/domains/:domain/references/:ref",
      summary: "Update a domain reference markdown file atomically",
      handler: (req) => {
        const body = asObject(req.body);
        if (typeof body.content !== "string" || !body.content.trim()) {
          throw new ValidationError("Request body must include non-empty string `content`");
        }
        return writeDomainReference(req.params.domain, req.params.ref, body.content);
      },
    },
    {
      method: "GET",
      pattern: "/api/domains/:domain/context/:tool",
      summary: "Resolve a single context tool for a subject (deterministic context preview)",
      handler: async (req) => {
        const subject = req.query.subject?.trim();
        if (!subject) {
          throw new ValidationError("Query parameter `subject` is required");
        }
        const tools = await loadContextTools(req.params.domain);
        const fn = tools[req.params.tool];
        if (!fn) {
          throw new ApiHttpError(
            `Unknown context tool "${req.params.tool}" in domain "${req.params.domain}"`,
            404,
            "not_found"
          );
        }
        const value = await fn(subject);
        return {
          domain: req.params.domain,
          tool: req.params.tool,
          subject,
          value,
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/domains/:domain/skills/:skill/gate",
      summary: "Evaluate a skill's gate triggers deterministically without calling the model",
      handler: async (req) => {
        const body = asObject(req.body);
        const subject = String(body.subject ?? "").trim();
        if (!subject) throw new ValidationError("Request body must include `subject`");
        const decision = await evaluateSkillGate(req.params.domain, req.params.skill, subject);
        return {
          domain: req.params.domain,
          skill: req.params.skill,
          subject,
          run: decision.run,
          reasons: decision.reasons,
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/domains/:domain/skills/:skill/assemble",
      summary: "Assemble a skill's full system + user prompt with resolved context and references",
      handler: async (req) => {
        const body = asObject(req.body);
        const subject = String(body.subject ?? "").trim();
        if (!subject) throw new ValidationError("Request body must include `subject`");
        const assembled = await assembleSkillPrompt(req.params.domain, req.params.skill, subject);
        return {
          domain: req.params.domain,
          skill: req.params.skill,
          subject,
          ...assembled,
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/domains/:domain/skills/:skill/run",
      summary: "Run a named skill against a subject through the core harness (with optional gate & verified output file)",
      handler: async (req) => {
        const body = asObject(req.body);
        const subject = String(body.subject ?? "").trim();
        if (!subject) throw new ValidationError("Request body must include `subject`");
        const gated = Boolean(body.gated);
        const outFile = typeof body.outFile === "string" && body.outFile.trim() ? body.outFile.trim() : undefined;

        if (!validateEnv()) {
          throw new ApiHttpError(
            "Environment validation failed — run `snestack setup` or check `/api/env`",
            400,
            "invalid_env"
          );
        }

        let gateDecision: { run: boolean; reasons: string[] } | undefined;
        if (gated) {
          gateDecision = await evaluateSkillGate(req.params.domain, req.params.skill, subject);
          if (!gateDecision.run) {
            return {
              status: "gated",
              domain: req.params.domain,
              skill: req.params.skill,
              subject,
              gate: gateDecision,
              result: null,
            };
          }
        }

        const result = await runSkill(req.params.domain, req.params.skill, subject);
        if (!result.output.trim()) {
          throw new ApiHttpError(
            `model returned no text (stop_reason: ${result.stopReason}, output_tokens: ${result.outputTokensUsed})`,
            502,
            "empty_model_output"
          );
        }

        const formattedText = `\n=== ${result.domain}/${result.skill} — ${result.subject} ===\n\n${result.output}\n`;
        if (outFile) {
          const problem = writeVerified(outFile, formattedText);
          if (problem) {
            throw new ApiHttpError(problem, 500, "write_verification_failed");
          }
        }

        if (result.verdictRequired && !result.verdict) {
          throw new ApiHttpError(
            'the output has no valid "VERDICT: LABEL | confidence | reasoning" line',
            422,
            "missing_verdict",
            { result, formattedText }
          );
        }

        return {
          status: result.stopReason === "max_tokens" ? "truncated" : "ok",
          domain: result.domain,
          skill: result.skill,
          subject: result.subject,
          gate: gateDecision ?? null,
          formattedText,
          result,
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/scripts",
      summary: "List scheduled automation scripts registered across domains",
      handler: (req) => {
        const nodeDir = defaultNodeDir();
        const domainFilter = req.query.domain?.trim();
        const byDomain = domainFilter
          ? { [domainFilter]: listDomainScripts(domainFilter, nodeDir) }
          : listAllDomainScripts(nodeDir);
        const scripts: Array<{ domain: string; script: string; path: string }> = [];
        for (const [domain, files] of Object.entries(byDomain)) {
          if (files.length === 0) continue;
          const dir = getDomainScriptsDir(domain, nodeDir);
          const relDir = dir ? path.relative(nodeDir, dir) : "";
          for (const f of files) {
            scripts.push({ domain, script: f, path: path.join(relDir, f) });
          }
        }
        return { scripts };
      },
    },
    {
      method: "POST",
      pattern: "/api/executor/check",
      summary: "Smoke-test the configured SNESTACK_EXECUTOR backend chain",
      handler: async (req) => {
        const body = asObject(req.body);
        const tierRaw = String(body.tier ?? "cheap");
        if (!(MODEL_TIERS as readonly string[]).includes(tierRaw)) {
          throw new ValidationError(`Invalid tier "${tierRaw}" — expected one of: ${MODEL_TIERS.join(", ")}`);
        }
        const tier = tierRaw as ModelTier;
        const config = getConfig();
        const chainDisplay = config.getExecutorChainDisplay();
        const r = await runPrompt(
          config.getExecutorApiKey(),
          "You are a smoke test. Reply with exactly: OK",
          "ping",
          { tier, maxTokens: 50, label: "executor-check" }
        );
        const usedBackend = r.backend ?? config.getExecutorBackend();
        let envKeyStripped: { kind: "gemini" | "anthropic"; stripped: boolean } | null = null;
        if (usedBackend === "agy-cli") {
          envKeyStripped = {
            kind: "gemini",
            stripped: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
          };
        } else if (usedBackend === "claude-cli") {
          envKeyStripped = {
            kind: "anthropic",
            stripped: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
          };
        }
        return {
          chain: chainDisplay,
          backend: usedBackend,
          fallbackFrom: r.fallbackFrom ?? null,
          model: r.model,
          reply: r.output.trim().slice(0, 80),
          inputTokensUsed: r.inputTokensUsed ?? null,
          outputTokensUsed: r.outputTokensUsed ?? null,
          latencyMs: r.latencyMs,
          stopReason: r.stopReason ?? null,
          envKeyStripped,
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/runs",
      summary: "List recent automation run summaries across registered domains",
      handler: async (req) => {
        const brainRoot = getConfig().getBrainRoot();
        const apis = await loadAllDomainApis();
        const targets: RunStatsTarget[] = [];
        for (const api of Object.values(apis)) {
          if (api.healthHooks?.getStatsTargets) {
            targets.push(...api.healthHooks.getStatsTargets(brainRoot));
          }
        }
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? "30", 10) || 30));
        const includeDryRun = req.query.includeDryRun === "true" || req.query.includeDryRun === "1";
        const runs = collectRecentRuns(targets, {
          domain: req.query.domain?.trim() || undefined,
          script: req.query.script?.trim() || undefined,
          includeDryRun,
          limit,
        });
        return { count: runs.length, runs };
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/report",
      summary: "Build a structured and human-readable run report from a run directory's run.jsonl",
      handler: (req) => {
        const dir = req.query.dir?.trim();
        if (!dir) throw new ValidationError("Query parameter `dir` is required");
        const events = readRunEvents(dir);
        if (events.length === 0) {
          throw new ApiHttpError(`no run events found in ${dir}`, 404, "not_found");
        }
        const report = buildRunReport(events);
        const summary = readSummary(dir);
        return {
          dir,
          eventCount: events.length,
          summary,
          report,
          text: formatRunReportText(report),
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/runs/events",
      summary: "Append a structured event to an active automation run's run.jsonl",
      handler: (req) => {
        const body = asObject(req.body);
        const type = String(body.type ?? "").trim();
        if (!type) throw new ValidationError("Request body must include event `type`");
        const dir = typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : currentRunDir();
        const fields: Record<string, unknown> = {};
        if (typeof body.script === "string" && body.script) fields.script = body.script;
        if (type === "run_start") fields.dry_run = Boolean(body.dryRun);
        if (typeof body.step === "string" && body.step) fields.step = body.step;
        if (typeof body.subject === "string" && body.subject) fields.subject = body.subject;
        if (typeof body.status === "string" && body.status) fields.status = body.status;
        if (body.exitCode !== undefined && body.exitCode !== null) {
          fields.exit_code = Number(body.exitCode);
        }
        if (body.durationMs !== undefined && body.durationMs !== null) {
          fields.duration_ms = Number(body.durationMs);
        }
        if (
          typeof body.errorFile === "string" &&
          body.errorFile &&
          body.status !== "ok" &&
          fs.existsSync(body.errorFile)
        ) {
          const summary = extractErrorSummary(fs.readFileSync(body.errorFile, "utf8"));
          fields[body.status === "failed" ? "error" : "detail"] = summary;
        } else if (typeof body.error === "string" && body.error) {
          fields[body.status === "failed" ? "error" : "detail"] = body.error;
        }
        logRunEvent(type, fields, dir);
        return { logged: Boolean(dir), dir: dir ?? null, type };
      },
    },
    {
      method: "POST",
      pattern: "/api/runs/finalize",
      summary: "Fold a run directory's run.jsonl into run.json and return the RunSummary",
      handler: (req) => {
        const body = asObject(req.body);
        const dir = typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : currentRunDir();
        if (!dir) {
          throw new ValidationError("no run directory (set SNESTACK_RUN_DIR or pass `dir`)");
        }
        const exitCode =
          body.exitCode !== undefined && body.exitCode !== null ? Number(body.exitCode) : null;
        const summary = finalizeRun(dir, exitCode);
        return { dir, summaryPath: path.join(dir, "run.json"), summary };
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/check",
      summary: "Evaluate recent automation runs, stale dry-runs, and domain health checks",
      handler: async (req) => {
        const days = Math.max(1, parseInt(req.query.days ?? "3", 10) || 3);
        const now = new Date();
        const brainRoot = getConfig().getBrainRoot();
        const apis = await loadAllDomainApis();

        const expectations: RunExpectation[] = [];
        const statsTargets: RunStatsTarget[] = [];
        const extraDryRunRoots: string[] = [path.join(brainRoot, "_system", "runs", "reflect")];

        for (const api of Object.values(apis)) {
          if (api.healthHooks?.getExpectations) {
            expectations.push(...api.healthHooks.getExpectations(brainRoot));
          }
          if (api.healthHooks?.getStatsTargets) {
            statsTargets.push(...api.healthHooks.getStatsTargets(brainRoot));
          }
          if (api.healthHooks?.getExtraDryRunRoots) {
            extraDryRunRoots.push(...api.healthHooks.getExtraDryRunRoots(brainRoot));
          }
        }

        const findings: Finding[] = evaluateRuns({
          now,
          days,
          expectations,
          brainRoot,
        });

        if (!findings.some((f) => f.code === "brain_root_unreadable")) {
          const dryRunRoots = [
            ...expectations.map((e) => e.runsRoot),
            ...statsTargets.map((t) => t.runsRoot),
            ...extraDryRunRoots,
          ];
          findings.push(...checkStaleDryRuns({ now, runsRoots: dryRunRoots }));
        }

        for (const api of Object.values(apis)) {
          if (api.healthHooks?.checkHealth) {
            findings.push(...(await api.healthHooks.checkHealth({ now, brainRoot })));
          }
        }

        const hasErrors = findings.some((f) => f.severity === "error");
        return {
          checked_at: now.toISOString(),
          days,
          date: dayString(now),
          ok: findings.length === 0,
          hasErrors,
          findings,
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/stats",
      summary: "Compute 7-day and 30-day model call cost, gate skip ratio, and redundancy stats",
      handler: async () => {
        const now = new Date();
        const brainRoot = getConfig().getBrainRoot();
        const apis = await loadAllDomainApis();
        const targets: RunStatsTarget[] = [];
        for (const api of Object.values(apis)) {
          if (api.healthHooks?.getStatsTargets) {
            targets.push(...api.healthHooks.getStatsTargets(brainRoot));
          }
        }
        const stats = computeRunStats(targets, now);
        return {
          computed_at: now.toISOString(),
          ...stats,
          formatted: formatRunStats(stats),
        };
      },
    },
  ];
}
