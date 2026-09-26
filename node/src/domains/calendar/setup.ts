import * as http from "http";
import { URL } from "url";
import { Config, getConfig } from "../../core/config";
import { createOAuthClient, CALENDAR_READONLY_SCOPE, REFRESH_TOKEN_KEY, REDIRECT_URI } from "./googleAuth";
import { getLogger } from "../../core/logger";

const logger = getLogger("CalendarSetup");

/**
 * One-time interactive OAuth consent flow for READ-ONLY Google Calendar access.
 * No calendar data is read or written here — this only establishes access for
 * later use by contextTools.ts. Requires FSTACK_GOOGLE_CLIENT_ID/
 * FSTACK_GOOGLE_CLIENT_SECRET already set from a Google Cloud "Desktop app"
 * OAuth client (see node/README.md for how to create one) — that step
 * requires the user's own Google Cloud Console access, not something this
 * flow can do on its own.
 */
export async function authorizeGoogleCalendar(envFile?: string): Promise<boolean> {
  let client;
  try {
    client = createOAuthClient();
  } catch (e) {
    console.log(`✗ ${e}`);
    console.log(
      "Set FSTACK_GOOGLE_CLIENT_ID and FSTACK_GOOGLE_CLIENT_SECRET first — see node/README.md " +
        "for how to create a Google Cloud OAuth 'Desktop app' client."
    );
    return false;
  }

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [CALENDAR_READONLY_SCOPE],
  });

  console.log("\nOpen this URL in your browser and grant read-only calendar access:\n");
  console.log(authUrl);
  console.log(`\nWaiting for the redirect to ${REDIRECT_URI} ...`);

  let code: string;
  try {
    code = await new Promise<string>((resolve, reject) => {
      const port = Number(new URL(REDIRECT_URI).port);
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "", REDIRECT_URI);
        const authCode = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.end(error ? "Authorization failed — you can close this tab." : "Authorized — you can close this tab.");
        server.close();
        if (error) reject(new Error(error));
        else if (authCode) resolve(authCode);
        else reject(new Error("No authorization code in redirect"));
      });
      server.listen(port);
      server.on("error", reject);
    });
  } catch (e) {
    logger.error(`OAuth callback failed: ${e}`);
    console.log(`\n✗ Authorization failed: ${e}`);
    return false;
  }

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.log(
      "\n✗ Google didn't return a refresh token. This happens when you've already granted this " +
        "app access before — revoke it at https://myaccount.google.com/permissions and re-run this " +
        "command, since a refresh token is only issued on first consent."
    );
    return false;
  }

  Config.set(REFRESH_TOKEN_KEY, tokens.refresh_token);
  const config = getConfig(envFile);
  const target = config.saveToFile(envFile);
  console.log(`\n✓ Refresh token saved to ${target}`);
  console.log("\nTry it: fstack run-skill calendar daily-agenda today");
  return true;
}
