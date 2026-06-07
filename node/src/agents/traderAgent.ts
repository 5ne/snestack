import nodemailer from "nodemailer";
import { BaseAgent } from "./base";
import { EmailServiceError } from "../core/errors";
import type { Signal } from "../core/models";
import type { Db } from "../core/db";

export class TraderAgent extends BaseAgent<boolean> {
  private readonly db: Db;
  private readonly gmailAddress: string;
  private readonly gmailAppPassword: string;
  private readonly notificationEmail: string;

  constructor(
    db: Db,
    gmailAddress: string,
    gmailAppPassword: string,
    notificationEmail: string
  ) {
    super("TraderAgent");
    this.db = db;
    this.gmailAddress = gmailAddress;
    this.gmailAppPassword = gmailAppPassword;
    this.notificationEmail = notificationEmail;
  }

  // TraderAgent doesn't do analysis — it sends
  async analyze(_ticker: string): Promise<boolean | null> {
    return false;
  }

  async sendBatchEmail(signals: Signal[], runDate?: string): Promise<boolean> {
    if (signals.length === 0) {
      this.logger.info("No signals to send");
      return true;
    }
    const date = runDate ?? new Date().toISOString().split("T")[0];
    try {
      const buys = signals.filter((s) => s.recommendation === "BUY");
      const sells = signals.filter((s) => s.recommendation === "SELL");
      const holds = signals.filter((s) => s.recommendation === "HOLD");

      const subject = TraderAgent.buildSubject(buys, sells, holds, date);
      const body = TraderAgent.buildEmailBody(buys, sells, holds, date);
      const success = await this.sendEmail(subject, body);

      if (success) {
        this.logger.info(
          `Email sent: ${signals.length} signals (${buys.length} BUY, ${sells.length} SELL, ${holds.length} HOLD)`
        );
        for (const signal of signals) {
          this.db.addSignal(
            signal.ticker,
            signal.date.toISOString(),
            signal.recommendation,
            signal.confidence,
            signal.reasoning,
            signal.fromWatchlist
          );
        }
      } else {
        this.logger.warn("Email send failed, queueing for retry");
        for (const signal of signals) {
          const signalId = this.db.addSignal(
            signal.ticker,
            signal.date.toISOString(),
            signal.recommendation,
            signal.confidence,
            signal.reasoning,
            signal.fromWatchlist
          );
          this.db.addPendingNotification(
            signal.ticker,
            signalId,
            this.notificationEmail,
            null,
            "email"
          );
        }
      }
      return success;
    } catch (e) {
      this.logger.error(`Batch email send failed: ${e}`);
      throw new EmailServiceError(`Batch email failed: ${e}`);
    }
  }

  async retryPendingNotifications(): Promise<number> {
    const pending = this.db.getPendingNotifications();
    if (pending.length === 0) {
      this.logger.info("No pending notifications");
      return 0;
    }
    let retried = 0;
    for (const notification of pending) {
      try {
        const signal = notification.signal_id
          ? this.db.getSignalById(notification.signal_id)
          : undefined;
        if (!signal) {
          this.db.removePendingNotification(notification.id);
          continue;
        }
        const success = await this.sendEmail(
          `fstack retry - ${signal.ticker}`,
          `${signal.recommendation}: ${signal.reasoning}`
        );
        if (success) {
          this.db.removePendingNotification(notification.id);
          retried++;
        } else {
          this.db.updatePendingNotificationRetry(notification.id);
        }
      } catch (e) {
        this.logger.error(`Retry failed for notification ${notification.id}: ${e}`);
        this.db.updatePendingNotificationRetry(notification.id);
      }
    }
    this.logger.info(`Retried ${retried} pending notifications`);
    return retried;
  }

  static buildSubject(
    buys: Signal[],
    sells: Signal[],
    holds: Signal[],
    date: string
  ): string {
    return `fstack analysis ${date} — ${buys.length} BUY, ${sells.length} SELL, ${holds.length} HOLD`;
  }

  static buildEmailBody(
    buys: Signal[],
    sells: Signal[],
    holds: Signal[],
    date: string
  ): string {
    const lines: string[] = [
      "fstack Investment Analysis",
      "=".repeat(50),
      `Date: ${date}`,
      "",
    ];

    if (buys.length) {
      lines.push("BUY SIGNALS", "-".repeat(50));
      for (const s of buys) {
        lines.push(
          s.ticker.toUpperCase(),
          `  Confidence: ${(s.confidence * 100).toFixed(0)}%`,
          `  Reason: ${s.reasoning}`,
          ""
        );
      }
    }
    if (sells.length) {
      lines.push("SELL SIGNALS", "-".repeat(50));
      for (const s of sells) {
        lines.push(
          s.ticker.toUpperCase(),
          `  Confidence: ${(s.confidence * 100).toFixed(0)}%`,
          `  Reason: ${s.reasoning}`,
          ""
        );
      }
    }
    if (holds.length) {
      lines.push("HOLD SIGNALS", "-".repeat(50));
      for (const s of holds) {
        lines.push(`${s.ticker.toUpperCase()} (${(s.confidence * 100).toFixed(0)}%)`);
      }
      lines.push("");
    }
    lines.push("=".repeat(50), "Generated by fstack", "Do not reply to this email");
    return lines.join("\n");
  }

  private async sendEmail(subject: string, body: string): Promise<boolean> {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: this.gmailAddress,
          pass: this.gmailAppPassword,
        },
      });
      await transporter.sendMail({
        from: this.gmailAddress,
        to: this.notificationEmail,
        subject,
        text: body,
      });
      this.logger.info(`Email sent to ${this.notificationEmail}`);
      return true;
    } catch (e) {
      this.logger.error(`Email send failed: ${e}`);
      return false;
    }
  }
}
