import * as http from "http";
import { URL } from "url";
import { Config, getConfig } from "../../core/config";
import { createOAuthClient, GMAIL_READONLY_SCOPE, REFRESH_TOKEN_KEY, REDIRECT_URI } from "./googleAuth";
import { getLogger } from "../../core/logger";

const logger = getLogger("TravelSetup");

/**
 * One-time interactive OAuth consent flow for READ-ONLY Gmail access. No mail
 * is read or sent here — this only establishes access for later use by
 * tools/gmailClient.ts. Requires SNESTACK_GOOGLE_CLIENT_ID/
 * SNESTACK_GOOGLE_CLIENT_SECRET already set (the same Google Cloud "Desktop
 * app" OAuth client the calendar domain uses — see node/README.md) and the
 * Gmail API enabled on that Google Cloud project.
 */
export async function authorizeGmail(envFile?: string): Promise<boolean> {
  const config = getConfig(envFile); // loads .env into process.env as a side effect — must happen before Config.require below

  let client;
  try {
    client = createOAuthClient();
  } catch (e) {
    console.log(`✗ ${e}`);
    console.log(
      "Set SNESTACK_GOOGLE_CLIENT_ID and SNESTACK_GOOGLE_CLIENT_SECRET first — see node/README.md " +
        "for how to create a Google Cloud OAuth 'Desktop app' client, and make sure the Gmail API " +
        "is enabled on that project."
    );
    return false;
  }

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_READONLY_SCOPE],
  });

  console.log("\nOpen this URL in your browser and grant read-only Gmail access:\n");
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
  const target = config.saveToFile(envFile);
  console.log(`\n✓ Refresh token saved to ${target}`);
  console.log("\nTry it: snestack travel catalog <year>");
  return true;
}
