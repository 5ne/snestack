import nodemailer from "nodemailer";
import { getConfig } from "./config";
import { getLogger } from "./logger";

const logger = getLogger("email");

/**
 * Minimal, domain-agnostic email sender for harness-level jobs (e.g. `reflect`,
 * which spans every registered domain) that aren't tied to one domain's own
 * agent. `domains/financial/agents/traderAgent.ts` has its own copy of this
 * for financial-specific emails (batch signals, run summaries) — this one
 * exists so a cross-domain job doesn't have to go through a financial-only
 * agent just to send mail.
 */
export async function sendEmail(subject: string, text: string, html?: string): Promise<boolean> {
  const config = getConfig();
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: config.getGmailAddress(), pass: config.getGmailAppPassword() },
    });
    await transporter.sendMail({
      from: config.getGmailAddress(),
      to: config.getNotificationEmail(),
      subject,
      text,
      ...(html ? { html } : {}),
    });
    logger.info(`Email sent to ${config.getNotificationEmail()}`);
    return true;
  } catch (e) {
    logger.error(`Email send failed: ${e}`);
    return false;
  }
}
