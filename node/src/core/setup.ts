import * as path from "path";
import prompts, { type PromptObject } from "prompts";
import { Config, getConfig } from "./config";
import { ConfigError } from "./errors";
import { getLogger } from "./logger";

const logger = getLogger("Setup");

class SetupCancelled extends Error {}

/** Ask a single prompt question; throws SetupCancelled on Ctrl+C. */
async function ask<T extends string = string>(
  question: PromptObject<T>
): Promise<Record<T, string>> {
  return prompts(question, {
    onCancel: () => {
      throw new SetupCancelled();
    },
  }) as Promise<Record<T, string>>;
}

function mask(key: string): string {
  if (key.length <= 4) return "*".repeat(key.length);
  return "*".repeat(key.length - 4) + key.slice(-4);
}

/**
 * Run interactive setup to configure API keys.
 *
 * Prompts for all required API keys, validates format, and stores them
 * in a .env file. Mirrors the Python implementation's setup_interactive.
 */
export async function setupInteractive(envFile?: string): Promise<boolean> {
  const targetFile = envFile ?? path.join(process.cwd(), ".env");

  console.log("\n" + "=".repeat(60));
  console.log("snestack Setup");
  console.log("=".repeat(60));
  console.log("\nThis will configure your API keys for snestack.");
  console.log("Press Ctrl+C to cancel.\n");

  try {
    // Finnhub
    console.log("1. FINNHUB API KEY");
    console.log("   Get free key at: https://finnhub.io/register");
    const { finnhubKey } = await ask({
      type: "password",
      name: "finnhubKey",
      message: "   Finnhub API Key:",
    });
    if (!finnhubKey) {
      console.log("   ✗ Finnhub key is required");
      return false;
    }
    if (!Config.validateApiKey(finnhubKey, "finnhub")) {
      console.log("   ✗ Invalid Finnhub key format");
      return false;
    }
    console.log("   ✓ Finnhub key validated");

    // Claude
    console.log("\n2. CLAUDE API KEY");
    console.log("   Get key at: https://console.anthropic.com/account/keys");
    const { claudeKey } = await ask({
      type: "password",
      name: "claudeKey",
      message: "   Claude API Key (sk-...):",
    });
    if (!claudeKey) {
      console.log("   ✗ Claude key is required");
      return false;
    }
    if (!Config.validateApiKey(claudeKey, "claude")) {
      console.log("   ✗ Invalid Claude key format (must start with sk-)");
      return false;
    }
    console.log("   ✓ Claude key validated");

    // Gmail
    console.log("\n3. GMAIL CONFIGURATION (for notifications)");
    console.log("   Generate app password: https://myaccount.google.com/apppasswords");
    const { gmailAddress } = await ask({
      type: "text",
      name: "gmailAddress",
      message: "   Gmail address:",
    });
    if (!gmailAddress || !gmailAddress.includes("@")) {
      console.log("   ✗ Invalid email address");
      return false;
    }

    const { gmailAppPassword } = await ask({
      type: "password",
      name: "gmailAppPassword",
      message: "   Gmail app password:",
    });
    if (!gmailAppPassword) {
      console.log("   ✗ Gmail app password is required");
      return false;
    }
    console.log("   ✓ Gmail configured");

    const { notificationEmail } = await ask({
      type: "text",
      name: "notificationEmail",
      message: "   Email to receive notifications:",
    });
    if (!notificationEmail || !notificationEmail.includes("@")) {
      console.log("   ✗ Invalid email address");
      return false;
    }
    console.log("   ✓ Notification email set");

    // Twilio (optional)
    console.log("\n4. TWILIO (optional, for SMS)");
    const { setupTwilio } = await ask({
      type: "confirm",
      name: "setupTwilio",
      message: "   Configure SMS notifications?",
      initial: false,
    });

    let twilioAccountSid: string | undefined;
    let twilioAuthToken: string | undefined;
    let smsPhone: string | undefined;

    if (setupTwilio) {
      console.log("   Get credentials at: https://www.twilio.com/console");
      const { sid } = await ask({
        type: "text",
        name: "sid",
        message: "   Twilio Account SID (AC...):",
      });
      if (sid) {
        if (!Config.validateApiKey(sid, "twilio_sid")) {
          console.log("   ✗ Invalid Twilio Account SID format");
        } else {
          const { token } = await ask({
            type: "password",
            name: "token",
            message: "   Twilio Auth Token:",
          });
          if (!token || !Config.validateApiKey(token, "twilio_token")) {
            console.log("   ✗ Invalid Twilio Auth Token");
          } else {
            const { phone } = await ask({
              type: "text",
              name: "phone",
              message: "   Your phone number (e.g. +1234567890):",
            });
            if (!phone) {
              console.log("   ✗ Phone number required");
            } else {
              twilioAccountSid = sid;
              twilioAuthToken = token;
              smsPhone = phone;
              console.log("   ✓ Twilio configured");
            }
          }
        }
      }
    } else {
      console.log("   ✓ SMS skipped");
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("Configuration Summary");
    console.log("=".repeat(60));
    console.log(`Finnhub API Key: ${mask(finnhubKey)}`);
    console.log(`Claude API Key:  ${mask(claudeKey)}`);
    console.log(`Gmail Address:   ${gmailAddress}`);
    console.log(`Notify Email:    ${notificationEmail}`);
    if (twilioAccountSid) {
      console.log(`Twilio SID:      ${twilioAccountSid.slice(-4)}`);
      console.log(`SMS Phone:       ${smsPhone}`);
    }
    console.log("=".repeat(60));

    const { confirmSave } = await ask({
      type: "confirm",
      name: "confirmSave",
      message: "\nSave configuration?",
      initial: true,
    });
    if (!confirmSave) {
      console.log("Setup cancelled.");
      return false;
    }

    // Save to env file
    Config.set("SNESTACK_FINNHUB_API_KEY", finnhubKey);
    Config.set("SNESTACK_CLAUDE_API_KEY", claudeKey);
    Config.set("SNESTACK_GMAIL_ADDRESS", gmailAddress);
    Config.set("SNESTACK_GMAIL_APP_PASSWORD", gmailAppPassword);
    Config.set("SNESTACK_NOTIFICATION_EMAIL", notificationEmail);

    if (twilioAccountSid && twilioAuthToken) {
      Config.set("SNESTACK_TWILIO_ACCOUNT_SID", twilioAccountSid);
      Config.set("SNESTACK_TWILIO_AUTH_TOKEN", twilioAuthToken);
      if (smsPhone) Config.set("SNESTACK_SMS_PHONE", smsPhone);
    }

    const config = getConfig(targetFile);
    config.saveToFile(targetFile);

    console.log(`\n✓ Configuration saved to ${targetFile}`);
    console.log("\nNext steps:");
    console.log("  1. Add your positions:");
    console.log("     snestack position add NVDA 100 850.0");
    console.log("  2. Add your watchlist:");
    console.log("     snestack watchlist add TSLA 'looking for dip'");
    console.log("  3. Run analysis:");
    console.log("     snestack batch");
    console.log("  4. Or set up cron for daily analysis:");
    console.log("     snestack scheduler --setup");
    console.log();

    return true;
  } catch (e) {
    if (e instanceof SetupCancelled) {
      console.log("\n\nSetup cancelled by user.");
      return false;
    }
    logger.error(`Setup error: ${e}`);
    console.log(`\n✗ Error: ${e}`);
    return false;
  }
}

/** Validate that all required environment variables are set. */
export function validateEnv(): boolean {
  try {
    const config = getConfig();
    config.getFinnhubApiKey();
    config.getClaudeApiKey();
    config.getGmailAddress();
    config.getNotificationEmail();
    return true;
  } catch (e) {
    if (e instanceof ConfigError) {
      logger.error(`Configuration validation failed: ${e}`);
      console.log(`✗ Configuration error: ${e.message}`);
      console.log("  Run 'snestack setup' to configure");
      return false;
    }
    throw e;
  }
}
