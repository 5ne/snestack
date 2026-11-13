import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import { Config, getConfig } from "../../core/config";
import { ValidationError } from "../../core/errors";
import { assembleSkillPrompt, runSkill } from "../../core/runSkill";
import { validateEnv } from "../../core/setup";
import { ApiHttpError, type ApiRoute, type CliContext, type DomainApiModule } from "../../core/api/types";
import {
  CLIENT_ID_KEY,
  CLIENT_SECRET_KEY,
  GMAIL_READONLY_SCOPE,
  REFRESH_TOKEN_KEY,
} from "./googleAuth";
import { authorizeGmail } from "./setup";
import { BACKFILL_END_YEAR, BACKFILL_START_YEAR, nextBackfillYear } from "./tools/backfill";
import { parseMultiFileOutput, writeCatalogFilesToDir, writeStagedCatalogFiles } from "./tools/fileWriter";
import { listExistingTripFiles, parseLastIndexedTripEndDate } from "./tools/timelineClient";

function asObject(val: unknown): Record<string, unknown> {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function validateYear(raw: string): string {
  const year = raw.trim();
  if (!/^\d{4}$/.test(year)) {
    throw new ValidationError(`Expected a 4-digit year, got "${raw}"`);
  }
  return year;
}

function isSafeFilename(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.includes("..") && name.endsWith(".md");
}

const routes: ApiRoute[] = [
  {
    method: "GET",
    pattern: "/api/domains/travel/status",
    summary: "Check travel domain Gmail OAuth, Timeline.json, and cataloged years status",
    handler: () => {
      const brainRoot = getConfig().getBrainRoot();
      const travelDir = path.join(brainRoot, "travel");
      const timelinePath = path.join(travelDir, "Timeline.json");
      const clientIdSet = Boolean(Config.get(CLIENT_ID_KEY));
      const clientSecretSet = Boolean(Config.get(CLIENT_SECRET_KEY));
      const refreshTokenSet = Boolean(Config.get(REFRESH_TOKEN_KEY));
      const nextYear = fs.existsSync(travelDir) ? nextBackfillYear(travelDir) : BACKFILL_START_YEAR;
      return {
        domain: "travel",
        gmailAuthorized: clientIdSet && clientSecretSet && refreshTokenSet,
        configured: {
          clientId: clientIdSet,
          clientSecret: clientSecretSet,
          gmailRefreshToken: refreshTokenSet,
        },
        scope: GMAIL_READONLY_SCOPE,
        timelinePath,
        timelineExists: fs.existsSync(timelinePath),
        nextBackfillYear: nextYear,
      };
    },
  },
  {
    method: "GET",
    pattern: "/api/domains/travel/years",
    summary: "List cataloged travel years under <brain>/travel/",
    handler: () => {
      const travelDir = path.join(getConfig().getBrainRoot(), "travel");
      if (!fs.existsSync(travelDir)) {
        return { years: [], nextBackfillYear: BACKFILL_START_YEAR };
      }
      const years = fs
        .readdirSync(travelDir)
        .filter((entry) => /^\d{4}$/.test(entry) && fs.statSync(path.join(travelDir, entry)).isDirectory())
        .sort()
        .reverse()
        .map((year) => {
          const yearDir = path.join(travelDir, year);
          const files = fs
            .readdirSync(yearDir)
            .filter((f) => f.endsWith(".md"))
            .sort();
          const hasIndex = files.includes(`00-index-${year}.md`);
          const tripFiles = listExistingTripFiles(yearDir);
          return { year: parseInt(year, 10), hasIndex, tripCount: tripFiles.length, files };
        });
      return { years, nextBackfillYear: nextBackfillYear(travelDir) };
    },
  },
  {
    method: "GET",
    pattern: "/api/domains/travel/years/:year",
    summary: "Inspect a travel year's index markdown and trip file list",
    handler: (req) => {
      const year = validateYear(req.params.year);
      const yearDir = path.join(getConfig().getBrainRoot(), "travel", year);
      if (!fs.existsSync(yearDir)) {
        throw new ApiHttpError(`Travel directory not found for ${year}`, 404, "not_found");
      }
      const files = fs
        .readdirSync(yearDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      const indexPath = path.join(yearDir, `00-index-${year}.md`);
      const indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : null;
      return {
        year: parseInt(year, 10),
        files,
        tripFiles: listExistingTripFiles(yearDir),
        indexContent,
      };
    },
  },
  {
    method: "GET",
    pattern: "/api/domains/travel/years/:year/files/:file",
    summary: "Read a trip or index markdown file inside <brain>/travel/<year>/",
    handler: (req) => {
      const year = validateYear(req.params.year);
      const filename = req.params.file.endsWith(".md") ? req.params.file : `${req.params.file}.md`;
      if (!isSafeFilename(filename)) {
        throw new ValidationError(`Invalid travel filename "${req.params.file}"`);
      }
      const filePath = path.join(getConfig().getBrainRoot(), "travel", year, filename);
      if (!fs.existsSync(filePath)) {
        throw new ApiHttpError(`Travel file not found: ${year}/${filename}`, 404, "not_found");
      }
      return {
        year: parseInt(year, 10),
        file: filename,
        path: filePath,
        content: fs.readFileSync(filePath, "utf8"),
      };
    },
  },
  {
    method: "GET",
    pattern: "/api/domains/travel/next-year",
    summary: `Return the next year to catalog (${BACKFILL_START_YEAR} down to ${BACKFILL_END_YEAR}), or null when complete`,
    handler: () => {
      const year = nextBackfillYear(path.join(getConfig().getBrainRoot(), "travel"));
      return { year };
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/travel/prep-catalog",
    summary: "Assemble the catalog-trip-year prompt with Timeline clusters (supports --since / --delta)",
    handler: async (req) => {
      const body = asObject(req.body);
      if (!validateEnv()) {
        throw new ApiHttpError("Environment validation failed", 400, "invalid_env");
      }
      const year = validateYear(String(body.year ?? ""));
      const rawSince = typeof body.since === "string" && body.since.trim() ? body.since.trim() : undefined;
      if (rawSince && !/^\d{4}-\d{2}-\d{2}$/.test(rawSince)) {
        throw new ValidationError(`Expected --since in YYYY-MM-DD format, got "${rawSince}"`);
      }

      const yearDir = path.join(getConfig().getBrainRoot(), "travel", year);
      let sinceDate = rawSince;
      if (!sinceDate && body.delta) {
        const indexPath = path.join(yearDir, `00-index-${year}.md`);
        if (fs.existsSync(indexPath)) {
          sinceDate = parseLastIndexedTripEndDate(fs.readFileSync(indexPath, "utf8"), parseInt(year, 10)) ?? undefined;
        }
        if (!sinceDate) {
          throw new ValidationError(
            `Could not infer --since from ${indexPath}; pass --since YYYY-MM-DD explicitly.`
          );
        }
      }

      const subject = sinceDate ? `${year}@${sinceDate}` : year;
      let { userPrompt } = await assembleSkillPrompt("travel", "catalog-trip-year", subject);
      if (sinceDate) {
        const existingFiles = listExistingTripFiles(yearDir);
        const fileList = existingFiles.length ? existingFiles.map((f) => `- ${f}`).join("\n") : "- (none yet)";
        userPrompt +=
          `\n\n## DELTA MODE (since ${sinceDate})\n` +
          `Only Timeline clusters ending after ${sinceDate} are included above. ` +
          `Search Gmail only for trips after ${sinceDate}, append new trip files, and update \`00-index-${year}.md\` without rewriting existing trips.\n` +
          `Existing files in \`travel/${year}/\`:\n${fileList}\n`;
      }

      const outPath = typeof body.outPath === "string" && body.outPath.trim() ? body.outPath.trim() : undefined;
      if (outPath) {
        fs.writeFileSync(outPath, userPrompt, "utf8");
      }

      return {
        year: parseInt(year, 10),
        since: sinceDate ?? null,
        outPath: outPath ?? null,
        prompt: userPrompt,
      };
    },
  },
  {
    method: "POST",
    pattern: "/api/domains/travel/catalog",
    summary: "Run automated catalog-trip-year skill for a year and write staged markdown files",
    handler: async (req) => {
      const body = asObject(req.body);
      if (!validateEnv()) {
        throw new ApiHttpError("Environment validation failed", 400, "invalid_env");
      }
      const year = validateYear(String(body.year ?? ""));
      const outDir = typeof body.outDir === "string" && body.outDir.trim() ? body.outDir.trim() : undefined;

      const result = await runSkill("travel", "catalog-trip-year", year);
      const files = parseMultiFileOutput(result.output);
      if (Object.keys(files).length === 0) {
        throw new ApiHttpError(
          "No '### FILE:' blocks found in the model output — nothing written.",
          422,
          "no_file_blocks",
          {
            stopReason: result.stopReason,
            outputTokensUsed: result.outputTokensUsed,
            output: result.output,
          }
        );
      }
      const written = outDir
        ? writeCatalogFilesToDir(outDir, files)
        : writeStagedCatalogFiles(getConfig().getBrainRoot(), parseInt(year, 10), files);

      return {
        status: result.stopReason === "max_tokens" ? "truncated" : "ok",
        year: parseInt(year, 10),
        outDir: outDir ?? null,
        written,
        stopReason: result.stopReason,
        outputTokensUsed: result.outputTokensUsed,
      };
    },
  },
];

function registerCli(program: Command, ctx: CliContext): void {
  const travel = program.command("travel").description("Travel brain domain");

  travel
    .command("auth")
    .description(
      "One-time OAuth consent for read-only Gmail access, needed before `travel catalog`. " +
        "Requires SNESTACK_GOOGLE_CLIENT_ID/SNESTACK_GOOGLE_CLIENT_SECRET already set — see node/README.md."
    )
    .option("--env-file <path>", "Path to .env file (default: .env)")
    .action(async (opts: { envFile?: string }) => {
      const ok = await authorizeGmail(opts.envFile);
      if (!ok) process.exitCode = 1;
    });

  travel
    .command("status")
    .description("Show travel domain Gmail OAuth and Timeline.json status")
    .action(async () => {
      const res = await ctx.getClient().get<{
        gmailAuthorized: boolean;
        timelineExists: boolean;
        timelinePath: string;
        nextBackfillYear: number | null;
      }>("/api/domains/travel/status");
      ctx.output(res, () => {
        console.log(`Gmail authorized: ${res.gmailAuthorized ? "yes" : "no"}`);
        console.log(`Timeline.json:    ${res.timelineExists ? "present" : "missing"} (${res.timelinePath})`);
        console.log(`Next backfill yr: ${res.nextBackfillYear ?? "(all cataloged)"}`);
      });
    });

  travel
    .command("years")
    .description("List cataloged travel years in <brain>/travel/")
    .action(async () => {
      const res = await ctx.getClient().get<{
        years: Array<{ year: number; hasIndex: boolean; tripCount: number }>;
      }>("/api/domains/travel/years");
      ctx.output(res, () => {
        if (res.years.length === 0) {
          console.log("No cataloged travel years found.");
          return;
        }
        res.years.forEach((y) => {
          console.log(`  ${y.year}  ${y.tripCount} trip file(s)  ${y.hasIndex ? "[indexed]" : "[no index]"}`);
        });
      });
    });

  travel
    .command("trips <year>")
    .description("List trip files for a cataloged year")
    .action(async (year: string) => {
      const res = await ctx.getClient().get<{
        year: number;
        files: string[];
      }>(`/api/domains/travel/years/${encodeURIComponent(year)}`);
      ctx.output(res, () => {
        res.files.forEach((f) => console.log(`  ${f}`));
      });
    });

  travel
    .command("show <year> <file>")
    .description("Read a trip or index markdown file from <brain>/travel/<year>/")
    .action(async (year: string, file: string) => {
      const res = await ctx.getClient().get<{ content: string }>(
        `/api/domains/travel/years/${encodeURIComponent(year)}/files/${encodeURIComponent(file)}`
      );
      ctx.output(res, () => {
        process.stdout.write(res.content);
      });
    });

  travel
    .command("catalog <year>")
    .description(
      "Fully automated catalog-trip-year run: fetches Gmail + Timeline clusters deterministically and writes staged files to .nightly-draft/"
    )
    .option("--out-dir <dir>", "Write the files here instead of the year's .nightly-draft/ staging directory")
    .action(async (year: string, opts: { outDir?: string }) => {
      if (!/^\d{4}$/.test(year)) {
        console.error(`Expected a 4-digit year, got "${year}"`);
        process.exitCode = 1;
        return;
      }
      try {
        console.error(`Fetching Gmail + Timeline context and running catalog-trip-year for ${year}...`);
        const res = await ctx.getClient().post<{
          status: "ok" | "truncated";
          written: string[];
          outDir: string | null;
          outputTokensUsed: number | null;
        }>("/api/domains/travel/catalog", { year, outDir: opts.outDir });
        ctx.output(res, () => {
          console.log(
            `Wrote ${res.written.length} file(s) to ${res.outDir ?? "the .nightly-draft/ staging directory"}:`
          );
          res.written.forEach((p) => console.log(`  ${p}`));
          if (res.status === "truncated") {
            console.log(
              `\nNote: stopped at max_tokens (${res.outputTokensUsed} output tokens) — check the files above before assuming the run is complete.`
            );
          }
          console.log("\nReview before promoting into the year's canonical files.");
        });
        if (res.status === "truncated") {
          process.exitCode = 3;
        }
      } catch (e) {
        if (e instanceof ApiHttpError && e.code === "no_file_blocks") {
          const d = (e.details ?? {}) as { stopReason?: string; outputTokensUsed?: number; output?: string };
          console.error(e.message);
          console.error(`stop_reason: ${d.stopReason}, output_tokens: ${d.outputTokensUsed}`);
          if (d.output) {
            console.error("Raw output:");
            console.error(d.output);
          }
          process.exitCode = 1;
          return;
        }
        console.error(`travel catalog failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });

  travel
    .command("prep-catalog <year>")
    .description(
      "Assemble the catalog-trip-year skill for <year> (skill body + Google Maps Timeline clusters) into one prompt."
    )
    .option("--out <path>", "Write the assembled prompt to a file instead of stdout")
    .option("--since <date>", "Delta mode: only include Timeline clusters ending after YYYY-MM-DD")
    .option("--delta", "Delta mode: infer --since from the last trip in 00-index-<year>.md")
    .action(async (year: string, opts: { out?: string; since?: string; delta?: boolean }) => {
      if (!/^\d{4}$/.test(year)) {
        console.error(`Expected a 4-digit year, got "${year}"`);
        process.exitCode = 1;
        return;
      }
      if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
        console.error(`Expected --since in YYYY-MM-DD format, got "${opts.since}"`);
        process.exitCode = 1;
        return;
      }
      try {
        const res = await ctx.getClient().post<{ prompt: string; outPath: string | null }>(
          "/api/domains/travel/prep-catalog",
          {
            year,
            since: opts.since,
            delta: Boolean(opts.delta),
            outPath: opts.out,
          }
        );
        if (ctx.isJson()) {
          console.log(JSON.stringify(res, null, 2));
        } else if (res.outPath) {
          console.error(`Wrote assembled prompt to ${res.outPath}`);
        } else {
          console.log(res.prompt);
        }
      } catch (e) {
        console.error(`travel prep-catalog failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    });

  travel
    .command("next-year")
    .description(
      `Print the next year the nightly backfill should catalog (${BACKFILL_START_YEAR} down to ${BACKFILL_END_YEAR}), or nothing once every year is done`
    )
    .action(async () => {
      const res = await ctx.getClient().get<{ year: number | null }>("/api/domains/travel/next-year");
      ctx.output(res, () => {
        if (res.year !== null) console.log(res.year);
      });
    });
}

export const domainApi: DomainApiModule = {
  routes,
  registerCli,
};
