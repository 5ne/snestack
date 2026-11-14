#!/usr/bin/env node
import * as fs from "fs";
import { Command } from "commander";
import { getConfig } from "./core/config";
import { loadAllDomainApis } from "./core/domainRegistry";
import { ExecutorError } from "./core/errors";
import { setupInteractive } from "./core/setup";
import {
  ApiHttpError,
  createApiClient,
  parseListenAddr,
  startApiServer,
  type ApiClient,
  type CliContext,
} from "./core/api";
import type { RunSummary } from "./core/runLog";
import type { Finding } from "./core/runCheck";

function formatCliError(e: unknown): string {
  if (e instanceof ExecutorError) return `[${e.code}] ${e.message}`;
  if (e instanceof ApiHttpError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export interface BuildCliOptions {
  client?: ApiClient;
}

export async function buildCliProgram(buildOpts: BuildCliOptions = {}): Promise<Command> {
  const program = new Command();

  program
    .name("snestack")
    .description("Isomorphic personal decision-support harness (CLI + HTTP API)")
    .version("1.0.0")
    .option("--json", "Print structured JSON output from the underlying API")
    .option("--api-url <url>", "Send commands over HTTP to a running `snestack serve` instance (or set SNESTACK_API_URL)")
    .option("--api-token <token>", "Bearer token for HTTP API requests (or set SNESTACK_API_TOKEN)");

  let cachedClient: ApiClient | null = buildOpts.client ?? null;

  const ctx: CliContext = {
    getClient(): ApiClient {
      if (cachedClient) return cachedClient;
      const globalOpts = program.opts<{ apiUrl?: string; apiToken?: string }>();
      cachedClient = createApiClient({
        apiUrl: globalOpts.apiUrl,
        apiToken: globalOpts.apiToken,
      });
      return cachedClient;
    },
    isJson(): boolean {
      return Boolean(program.opts<{ json?: boolean }>().json);
    },
    output(data: unknown, formatHuman: () => void): void {
      if (this.isJson()) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        formatHuman();
      }
    },
  };

  // ── HTTP API Server (`snestack serve`) ───────────────────────────────────

  program
    .command("serve")
    .description(
      "Start the snestack HTTP JSON API server (defaults to 127.0.0.1:4700, or 0.0.0.0:$PORT when PORT is set)"
    )
    .option("--addr <addr>", "Listen address as host:port or :port (e.g. 127.0.0.1:4700)")
    .option("--host <host>", "Bind host (default: 127.0.0.1, or 0.0.0.0 when PORT is set)")
    .option("--port <port>", "Bind port (default: 4700, or $PORT)")
    .option(
      "--allow-unauthenticated-remote",
      "Allow binding a non-loopback address without SNESTACK_API_TOKEN configured"
    )
    .action(
      async (opts: {
        addr?: string;
        host?: string;
        port?: string;
        allowUnauthenticatedRemote?: boolean;
      }) => {
        const globalOpts = program.opts<{ apiToken?: string }>();
        let host = opts.host;
        let port = opts.port !== undefined ? parseInt(opts.port, 10) : undefined;
        if (opts.addr) {
          const parsed = parseListenAddr(opts.addr);
          host = parsed.host;
          port = parsed.port;
        }
        const running = await startApiServer({
          host,
          port,
          apiToken: globalOpts.apiToken,
          allowUnauthenticatedRemote: Boolean(opts.allowUnauthenticatedRemote),
        });
        if (ctx.isJson()) {
          console.log(
            JSON.stringify({
              status: "listening",
              host: running.host,
              port: running.port,
              url: running.url,
              routes: running.router.listRoutes().length,
            })
          );
        } else {
          console.log(
            `snestack API server listening on ${running.url} (${running.router.listRoutes().length} routes)`
          );
        }

        await new Promise<void>((resolve) => {
          const shutdown = () => {
            running.close().finally(() => resolve());
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
      }
    );

  // ── Interactive Setup & Non-Interactive Readiness ────────────────────────

  program
    .command("setup")
    .description("Interactive setup for API keys and notifications")
    .option("--env-file <path>", "Path to .env file (default: .env)")
    .action(async (opts: { envFile?: string }) => {
      const ok = await setupInteractive(opts.envFile);
      if (!ok) process.exitCode = 1;
    });

  program
    .command("health")
    .description("Check server/harness health and registered domains")
    .action(async () => {
      const res = await ctx.getClient().get<{
        status: string;
        version: string;
        domains: string[];
        authRequired: boolean;
      }>("/api/health");
      ctx.output(res, () => {
        console.log(
          `snestack v${res.version} [${res.status}] — domains: ${res.domains.join(", ")} (auth: ${
            res.authRequired ? "token" : "loopback/open"
          })`
        );
      });
    });

  program
    .command("routes")
    .description("List every HTTP API route registered across core and domains")
    .option("--scope <scope>", "Filter by scope (core or domain name)")
    .action(async (opts: { scope?: string }) => {
      const res = await ctx.getClient().get<{
        count: number;
        routes: Array<{ method: string; pattern: string; summary: string; scope: string }>;
      }>("/api/routes", { scope: opts.scope });
      ctx.output(res, () => {
        res.routes.forEach((r) => {
          console.log(`${r.method.padEnd(7)} ${r.pattern.padEnd(44)} [${r.scope}] ${r.summary}`);
        });
      });
    });

  program
    .command("env-check")
    .description("Check non-secret configuration and environment readiness")
    .action(async () => {
      const res = await ctx.getClient().get<{
        valid: boolean;
        missingRequired: string[];
        executorChain: string;
        brainRoot: string;
        brainRootExists: boolean;
      }>("/api/env");
      ctx.output(res, () => {
        console.log(`Environment valid: ${res.valid ? "yes" : "no"}`);
        console.log(`Executor chain:    ${res.executorChain}`);
        console.log(`Brain root:        ${res.brainRoot} (${res.brainRootExists ? "exists" : "missing"})`);
        if (res.missingRequired.length > 0) {
          console.log(`Missing required:  ${res.missingRequired.join(", ")}`);
        }
      });
      if (!res.valid) process.exitCode = 1;
    });

  // ── Domain & Skill Introspection ─────────────────────────────────────────

  program
    .command("domains")
    .description("List registered domains with their skills, references, context tools, and scripts")
    .action(async () => {
      const res = await ctx.getClient().get<{
        domains: Array<{
          name: string;
          skills: Array<{ name: string }>;
          references: string[];
          contextTools: string[];
          scripts: string[];
        }>;
      }>("/api/domains");
      ctx.output(res, () => {
        res.domains.forEach((d) => {
          console.log(
            `${d.name.padEnd(12)} skills=[${d.skills.map((s) => s.name).join(", ")}]  tools=[${d.contextTools.join(
              ", "
            )}]  scripts=${d.scripts.length}`
          );
        });
      });
    });

  program
    .command("skills [domain]")
    .description("List runnable skills across all domains or a single domain")
    .option("--all", "Include non-runnable docs (vision, pm, eng, INDEX)")
    .action(async (domain: string | undefined, opts: { all?: boolean }) => {
      if (domain) {
        const res = await ctx.getClient().get<{
          domain: string;
          skills: Array<{ name: string; model: string; hasGate: boolean; verdict: boolean; runnable: boolean }>;
        }>(`/api/domains/${encodeURIComponent(domain)}/skills`, {
          all: opts.all ? "true" : undefined,
        });
        ctx.output(res, () => {
          res.skills.forEach((s) => {
            console.log(
              `${res.domain}/${s.name.padEnd(26)} model=${s.model.padEnd(9)} gate=${String(s.hasGate).padEnd(
                5
              )} verdict=${s.verdict}${s.runnable ? "" : " [doc]"}`
            );
          });
        });
        return;
      }
      const res = await ctx.getClient().get<{
        domains: Array<{
          name: string;
          skills: Array<{ name: string; model: string; hasGate: boolean; verdict: boolean }>;
        }>;
      }>("/api/domains");
      ctx.output(res, () => {
        for (const d of res.domains) {
          for (const s of d.skills) {
            console.log(
              `${d.name}/${s.name.padEnd(26)} model=${s.model.padEnd(9)} gate=${String(s.hasGate).padEnd(
                5
              )} verdict=${s.verdict}`
            );
          }
        }
      });
    });

  program
    .command("skill-show <domain> <skill>")
    .description("Inspect a skill's frontmatter, markdown body, and referenced files")
    .action(async (domain: string, skill: string) => {
      const res = await ctx.getClient().get<{
        domain: string;
        name: string;
        frontmatter: Record<string, unknown>;
        body: string;
        references: Record<string, string>;
      }>(`/api/domains/${encodeURIComponent(domain)}/skills/${encodeURIComponent(skill)}`);
      ctx.output(res, () => {
        console.log(`=== ${res.domain}/${res.name} ===`);
        console.log(res.body.trim());
      });
    });

  const referencesCmd = program.command("references").description("Inspect or update domain skill reference files");

  referencesCmd
    .command("list <domain>")
    .description("List shared reference markdown files in a domain")
    .action(async (domain: string) => {
      const res = await ctx.getClient().get<{ domain: string; references: string[] }>(
        `/api/domains/${encodeURIComponent(domain)}/references`
      );
      ctx.output(res, () => {
        if (res.references.length === 0) {
          console.log(`No references in ${res.domain}.`);
          return;
        }
        res.references.forEach((r) => console.log(`${res.domain}  ${r}`));
      });
    });

  referencesCmd
    .command("show <domain> <ref>")
    .description("Print a domain reference markdown file (e.g. financial quality-bar)")
    .action(async (domain: string, ref: string) => {
      const res = await ctx.getClient().get<{ content: string }>(
        `/api/domains/${encodeURIComponent(domain)}/references/${encodeURIComponent(ref)}`
      );
      ctx.output(res, () => {
        process.stdout.write(res.content);
      });
    });

  referencesCmd
    .command("set <domain> <ref>")
    .description("Atomically update a domain reference markdown file from --file")
    .requiredOption("--file <path>", "Markdown file to write into the reference")
    .action(async (domain: string, ref: string, opts: { file: string }) => {
      const content = fs.readFileSync(opts.file, "utf8");
      const res = await ctx.getClient().put<{ domain: string; name: string; path: string }>(
        `/api/domains/${encodeURIComponent(domain)}/references/${encodeURIComponent(ref)}`,
        { content }
      );
      ctx.output(res, () => {
        console.log(`Updated reference ${res.domain}/${res.name}: ${res.path}`);
      });
    });

  program
    .command("context <domain> <tool> <subject>")
    .description("Resolve a single domain context tool for a subject (deterministic preview)")
    .action(async (domain: string, tool: string, subject: string) => {
      const res = await ctx.getClient().get<{ value: unknown }>(
        `/api/domains/${encodeURIComponent(domain)}/context/${encodeURIComponent(tool)}`,
        { subject }
      );
      if (ctx.isJson()) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(JSON.stringify(res.value, null, 2));
      }
    });

  // ── Skill Execution, Gating & Assembly ───────────────────────────────────

  program
    .command("gate-skill <domain> <skill> <subject>")
    .description("Evaluate a skill's gate triggers deterministically without calling the model")
    .action(async (domain: string, skill: string, subject: string) => {
      const res = await ctx.getClient().post<{
        domain: string;
        skill: string;
        subject: string;
        run: boolean;
        reasons: string[];
      }>(`/api/domains/${encodeURIComponent(domain)}/skills/${encodeURIComponent(skill)}/gate`, { subject });
      ctx.output(res, () => {
        console.log(
          `gate: ${res.run ? "run" : "skip"} ${res.domain}/${res.skill} ${res.subject} - ${res.reasons.join("; ")}`
        );
      });
      if (!res.run) process.exitCode = 4;
    });

  program
    .command("assemble-skill <domain> <skill> <subject>")
    .description("Assemble a skill's full prompt (with resolved context + references) without calling the model")
    .option("--out <file>", "Write the assembled userPrompt to a file instead of stdout")
    .action(async (domain: string, skill: string, subject: string, opts: { out?: string }) => {
      const res = await ctx.getClient().post<{
        systemPrompt: string;
        userPrompt: string;
        tier: string;
      }>(`/api/domains/${encodeURIComponent(domain)}/skills/${encodeURIComponent(skill)}/assemble`, { subject });
      if (opts.out) {
        fs.writeFileSync(opts.out, res.userPrompt, "utf8");
      }
      ctx.output(res, () => {
        if (!opts.out) console.log(res.userPrompt);
      });
    });

  program
    .command("run-skill <domain> <skill> <subject>")
    .description(
      "Run a named skill against a subject through the core harness (e.g. run-skill financial long-term-quality NVDA)"
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
      try {
        const res = await ctx.getClient().post<{
          status: "ok" | "gated" | "truncated";
          domain: string;
          skill: string;
          subject: string;
          gate: { run: boolean; reasons: string[] } | null;
          formattedText?: string;
          result: { outputTokensUsed: number | null } | null;
        }>(`/api/domains/${encodeURIComponent(domain)}/skills/${encodeURIComponent(skill)}/run`, {
          subject,
          gated: Boolean(opts.gated),
          outFile: opts.out,
        });

        if (res.status === "gated" && res.gate) {
          console.error(`gate: skipped ${domain}/${skill} ${subject} - ${res.gate.reasons.join("; ")}`);
          if (ctx.isJson()) console.log(JSON.stringify(res, null, 2));
          process.exitCode = 4;
          return;
        }
        if (res.gate?.run) {
          console.error(`gate: running ${domain}/${skill} ${subject} - ${res.gate.reasons.join("; ")}`);
        }

        if (ctx.isJson()) {
          console.log(JSON.stringify(res, null, 2));
        } else if (!opts.out && res.formattedText) {
          process.stdout.write(res.formattedText);
        }

        if (res.status === "truncated") {
          console.error(
            `run-skill warning: output truncated at max_tokens (${res.result?.outputTokensUsed ?? "?"} output tokens)`
          );
          process.exitCode = 3;
        }
      } catch (e) {
        if (e instanceof ApiHttpError) {
          if (e.code === "invalid_env") {
            process.exitCode = 1;
            return;
          }
          if (e.code === "write_verification_failed") {
            console.error(`run-skill failed: ${e.message}`);
            process.exitCode = 5;
            return;
          }
          if (e.code === "missing_verdict") {
            const details = (e.details ?? {}) as { formattedText?: string };
            if (!opts.out && !ctx.isJson() && details.formattedText) {
              process.stdout.write(details.formattedText);
            }
            console.error(`run-skill failed: ${e.message}`);
            process.exitCode = 1;
            return;
          }
        }
        console.error(`run-skill failed: ${formatCliError(e)}`);
        process.exitCode = 1;
      }
    });

  // ── Run Logging, Run History & Health Checks ─────────────────────────────

  const runsCmd = program.command("runs").description("Browse and inspect past automation runs");

  runsCmd
    .command("list", { isDefault: true })
    .description("List recent completed automation runs across registered domains")
    .option("--domain <d>", "Filter by domain")
    .option("--script <s>", "Filter by script name")
    .option("--limit <n>", "Max runs to show", "30")
    .option("--include-dry-run", "Include -dryrun directories")
    .action(
      async (opts: { domain?: string; script?: string; limit: string; includeDryRun?: boolean }) => {
        const res = await ctx.getClient().get<{
          count: number;
          runs: Array<{ domain: string; script: string; date: string; dir: string; summary: RunSummary }>;
        }>("/api/runs", {
          domain: opts.domain,
          script: opts.script,
          limit: parseInt(opts.limit, 10) || 30,
          includeDryRun: opts.includeDryRun ? "true" : undefined,
        });
        ctx.output(res, () => {
          if (res.runs.length === 0) {
            console.log("No recorded runs found.");
            return;
          }
          res.runs.forEach((r) => {
            console.log(
              `${r.date}  ${r.domain.padEnd(10)} ${r.script.padEnd(28)} [${r.summary.status}]  calls=${r.summary.model_calls.count}`
            );
          });
        });
      }
    );

  runsCmd
    .command("report <dir>")
    .description("Show the structured report for a run directory")
    .action(async (dir: string) => {
      const res = await ctx.getClient().get<{ text: string }>("/api/runs/report", { dir });
      ctx.output(res, () => {
        console.log(res.text);
      });
    });

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
      async (
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
        const res = await ctx.getClient().post("/api/runs/events", {
          type,
          dir: opts.dir,
          script: opts.script,
          dryRun: Boolean(opts.dryRun),
          step: opts.step,
          subject: opts.subject,
          status: opts.status,
          exitCode: opts.exitCode !== undefined ? parseInt(opts.exitCode, 10) : undefined,
          durationMs: opts.durationMs !== undefined ? parseInt(opts.durationMs, 10) : undefined,
          errorFile: opts.errorFile,
        });
        if (ctx.isJson()) {
          console.log(JSON.stringify(res, null, 2));
        }
      }
    );

  runLog
    .command("finalize")
    .description("Fold the run's events into run.json and print a one-line summary; exits 1 if the run failed")
    .option("--dir <dir>", "Run directory (default: $SNESTACK_RUN_DIR)")
    .option("--exit-code <n>", "The automation script's own exit code")
    .action(async (opts: { dir?: string; exitCode?: string }) => {
      try {
        const res = await ctx.getClient().post<{
          dir: string;
          summaryPath: string;
          summary: RunSummary;
        }>("/api/runs/finalize", {
          dir: opts.dir,
          exitCode: opts.exitCode !== undefined ? parseInt(opts.exitCode, 10) : undefined,
        });
        const summary = res.summary;
        const m = summary.model_calls;
        console.error(
          `Run ${summary.status}: ${summary.steps.ok}/${summary.steps.total} steps ok, ${summary.steps.failed} failed, ` +
            `${summary.steps.truncated} truncated; ${m.count} model calls (${m.input_tokens} in / ${m.output_tokens} out tokens, ` +
            `~${m.est_cost_usd == null ? "unknown cost" : "$" + m.est_cost_usd.toFixed(2)}` +
            `${m.api_equivalent_usd ? `, subscription calls ~$${m.api_equivalent_usd.toFixed(2)} at API prices` : ""}` +
            `${m.subscription_fallbacks ? `; ${m.subscription_fallbacks} call(s) fell back across subscription CLIs` : ""}` +
            `${m.api_fallbacks ? `; WARNING ${m.api_fallbacks} call(s) fell back to the metered API` : ""}). Summary: ${res.summaryPath}`
        );
        if (ctx.isJson()) {
          console.log(JSON.stringify(res, null, 2));
        }
        if (summary.status === "failed") process.exitCode = 1;
      } catch (e) {
        console.error(`run-log finalize: ${formatCliError(e)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("executor-check")
    .description(
      "Smoke test: send one tiny prompt through the configured executor chain (SNESTACK_EXECUTOR) and print backend, model, tokens, latency"
    )
    .option("--tier <t>", "cheap | normal | expensive", "cheap")
    .action(async (opts: { tier: string }) => {
      try {
        const res = await ctx.getClient().post<{
          chain: string;
          backend: string;
          fallbackFrom: string | null;
          model: string;
          reply: string;
          inputTokensUsed: number | null;
          outputTokensUsed: number | null;
          latencyMs: number;
          stopReason: string | null;
          envKeyStripped: { kind: "gemini" | "anthropic"; stripped: boolean } | null;
        }>("/api/executor/check", { tier: opts.tier });
        ctx.output(res, () => {
          console.log(`chain: ${res.chain}`);
          console.log(`backend: ${res.backend}${res.fallbackFrom ? ` (fallback from ${res.fallbackFrom})` : ""}`);
          console.log(`model: ${res.model}`);
          console.log(`reply: ${res.reply}`);
          console.log(
            `tokens: ${res.inputTokensUsed ?? "?"} in / ${res.outputTokensUsed ?? "?"} out; latency ${res.latencyMs}ms; stop ${res.stopReason ?? "?"}`
          );
          if (res.envKeyStripped?.kind === "gemini") {
            console.log(
              `Gemini API key env stripped from child: ${
                res.envKeyStripped.stripped ? "yes (was set in this shell)" : "n/a (was not set)"
              }`
            );
          } else if (res.envKeyStripped?.kind === "anthropic") {
            console.log(
              `Anthropic API key env stripped from child: ${
                res.envKeyStripped.stripped ? "yes (was set in this shell)" : "n/a (was not set)"
              }`
            );
          }
        });
      } catch (e) {
        console.error(`executor-check failed (${getConfig().getExecutorChainDisplay()}): ${formatCliError(e)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("run-check")
    .description(
      "Check recent automation runs for problems: missing or crashed runs, failed or truncated steps, model errors, cost spikes, and domain cache/thesis health."
    )
    .option("--days <n>", "How many days back to check, including today", "3")
    .option(
      "--cost",
      "Instead of health findings, print a read-only cost rollup per script and per domain over 7 and 30 days"
    )
    .action(async (opts: { days: string; cost?: boolean }) => {
      if (opts.cost) {
        const res = await ctx.getClient().get<{
          computed_at: string;
          scripts: unknown[];
          domains: unknown[];
          formatted: string;
        }>("/api/runs/stats");
        if (ctx.isJson()) {
          const { formatted: _f, ...jsonPayload } = res;
          console.log(JSON.stringify(jsonPayload, null, 2));
        } else {
          console.log(res.formatted);
        }
        return;
      }

      const res = await ctx.getClient().get<{
        checked_at: string;
        date: string;
        ok: boolean;
        hasErrors: boolean;
        findings: Finding[];
      }>("/api/runs/check", { days: parseInt(opts.days, 10) || 3 });

      if (ctx.isJson()) {
        console.log(
          JSON.stringify(
            {
              checked_at: res.checked_at,
              ok: res.ok,
              findings: res.findings,
            },
            null,
            2
          )
        );
      } else if (res.findings.length === 0) {
        console.log(`All clear: no problems in the last ${opts.days} day(s) (${res.date}).`);
      } else {
        res.findings.forEach((f) =>
          console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.domain} ${f.date} [${f.code}] ${f.message}`)
        );
      }
      if (res.hasErrors) process.exitCode = 1;
    });

  program
    .command("scripts")
    .description("List scheduled automation scripts registered by each domain in config/domains.json")
    .option("--domain <d>", "Only show scripts for this domain")
    .action(async (opts: { domain?: string }) => {
      const res = await ctx.getClient().get<{
        scripts: Array<{ domain: string; script: string; path: string }>;
      }>("/api/scripts", { domain: opts.domain });
      ctx.output(res, () => {
        if (res.scripts.length === 0) {
          console.log("No domain scripts registered.");
          return;
        }
        res.scripts.forEach((s) => console.log(`${s.domain}  ${s.path}`));
      });
    });

  // ── Mount Registered Domain CLI Surfaces ─────────────────────────────────

  const domainApis = await loadAllDomainApis();
  for (const mod of Object.values(domainApis)) {
    if (mod.registerCli) {
      mod.registerCli(program, ctx);
    }
  }

  return program;
}

if (require.main === module) {
  buildCliProgram()
    .then((program) => program.parseAsync(process.argv))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
