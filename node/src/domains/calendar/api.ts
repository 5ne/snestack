import type { Command } from "commander";
import { Config } from "../../core/config";
import { ValidationError } from "../../core/errors";
import type { ApiRoute, CliContext, DomainApiModule } from "../../core/api/types";
import { contextTools } from "./contextTools";
import {
  CALENDAR_READONLY_SCOPE,
  CLIENT_ID_KEY,
  CLIENT_SECRET_KEY,
  createOAuthClient,
  REFRESH_TOKEN_KEY,
} from "./googleAuth";
import { authorizeGoogleCalendar } from "./setup";

function validateScope(scope: string): string {
  const s = scope.trim();
  if (s === "today" || s === "upcoming" || /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }
  throw new ValidationError(`Invalid calendar scope "${scope}" — expected "today", "upcoming", or YYYY-MM-DD`);
}

const routes: ApiRoute[] = [
  {
    method: "GET",
    pattern: "/api/domains/calendar/status",
    summary: "Check Google Calendar OAuth configuration status",
    handler: () => {
      const clientIdSet = Boolean(Config.get(CLIENT_ID_KEY));
      const clientSecretSet = Boolean(Config.get(CLIENT_SECRET_KEY));
      const refreshTokenSet = Boolean(Config.get(REFRESH_TOKEN_KEY));
      return {
        domain: "calendar",
        authorized: clientIdSet && clientSecretSet && refreshTokenSet,
        configured: {
          clientId: clientIdSet,
          clientSecret: clientSecretSet,
          refreshToken: refreshTokenSet,
        },
        scope: CALENDAR_READONLY_SCOPE,
      };
    },
  },
  {
    method: "GET",
    pattern: "/api/domains/calendar/auth-url",
    summary: "Generate a read-only Google Calendar OAuth consent URL",
    handler: () => {
      const client = createOAuthClient();
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [CALENDAR_READONLY_SCOPE],
      });
      return { authUrl, scope: CALENDAR_READONLY_SCOPE };
    },
  },
  {
    method: "GET",
    pattern: "/api/domains/calendar/events",
    summary: "Fetch Google Calendar events for `today`, `upcoming`, or an ISO date (`YYYY-MM-DD`)",
    handler: async (req) => {
      const scope = validateScope(req.query.scope ?? "today");
      const events = await contextTools.events(scope);
      return { scope, events };
    },
  },
];

function registerCli(program: Command, ctx: CliContext): void {
  const calendar = program.command("calendar").description("Google Calendar domain");

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

  calendar
    .command("status")
    .description("Show Google Calendar OAuth readiness")
    .action(async () => {
      const res = await ctx.getClient().get<{
        authorized: boolean;
        configured: { clientId: boolean; clientSecret: boolean; refreshToken: boolean };
      }>("/api/domains/calendar/status");
      ctx.output(res, () => {
        console.log(`Calendar authorized: ${res.authorized ? "yes" : "no"}`);
        console.log(
          `  client_id=${res.configured.clientId}  client_secret=${res.configured.clientSecret}  refresh_token=${res.configured.refreshToken}`
        );
      });
    });

  calendar
    .command("events [scope]")
    .description("Fetch raw calendar events for `today` (default), `upcoming` (7d), or `YYYY-MM-DD`")
    .action(async (scope = "today") => {
      const res = await ctx.getClient().get<{
        scope: string;
        events: Array<{ summary?: string; start?: string; end?: string; location?: string }>;
      }>("/api/domains/calendar/events", { scope });
      ctx.output(res, () => {
        if (!Array.isArray(res.events) || res.events.length === 0) {
          console.log(`No calendar events for ${res.scope}.`);
          return;
        }
        res.events.forEach((e) => {
          console.log(`  ${e.start ?? "?"} -> ${e.end ?? "?"}  ${e.summary ?? "(untitled)"}`);
        });
      });
    });
}

export const domainApi: DomainApiModule = {
  routes,
  registerCli,
};
