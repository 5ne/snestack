import nodemailer from "nodemailer";
import { BaseAgent } from "./base";
import { EmailServiceError } from "../core/errors";
import type { Signal } from "../core/models";
import type { Db } from "../core/db";

const COLORS: Record<"BUY" | "SELL" | "HOLD", { fg: string; bg: string; border: string }> = {
  BUY: { fg: "#0f7a3d", bg: "#e9f9ef", border: "#16a34a" },
  SELL: { fg: "#b91c1c", bg: "#fdeeee", border: "#dc2626" },
  HOLD: { fg: "#475569", bg: "#f1f5f9", border: "#94a3b8" },
};

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
      const text = TraderAgent.buildEmailBody(buys, sells, holds, date);
      const html = TraderAgent.buildEmailHtml(buys, sells, holds, date);
      const success = await this.sendEmail(subject, text, html);

      if (success) {
        this.logger.info(
          `Email sent: ${signals.length} signals (${buys.length} BUY, ${sells.length} SELL, ${holds.length} HOLD)`
        );
        for (const signal of signals) {
          this.db.addTicker(signal.ticker, signal.ticker, "PUBLIC");
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
          this.db.addTicker(signal.ticker, signal.ticker, "PUBLIC");
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
        const text = `${signal.recommendation}: ${signal.reasoning}`;
        const html = TraderAgent.buildRetryHtml(signal);
        const success = await this.sendEmail(
          `fstack retry - ${signal.ticker}`,
          text,
          html
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

  // ---------- HTML email rendering ----------

  private static escapeHtml(input: string): string {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private static formatDate(date: string): string {
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return date;
    return parsed.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  private static confidencePill(confidence: number, kind: "BUY" | "SELL" | "HOLD"): string {
    const c = COLORS[kind];
    const pct = Math.round(confidence * 100);
    return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${c.bg};color:${c.fg};font-size:12px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${pct}% confidence</span>`;
  }

  private static signalCard(s: Signal, kind: "BUY" | "SELL" | "HOLD"): string {
    const c = COLORS[kind];
    const ticker = TraderAgent.escapeHtml(s.ticker.toUpperCase());
    const reasoning = TraderAgent.escapeHtml(s.reasoning);
    const watchlistTag = s.fromWatchlist
      ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:11px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">WATCHLIST</span>`
      : "";
    return `
      <tr>
        <td style="padding:0 0 12px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e9ef;border-left:4px solid ${c.border};border-radius:8px;">
            <tr>
              <td style="padding:14px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#0f172a;letter-spacing:0.3px;">
                      ${ticker}${watchlistTag}
                    </td>
                    <td align="right">${TraderAgent.confidencePill(s.confidence, kind)}</td>
                  </tr>
                </table>
                <p style="margin:8px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13.5px;line-height:1.5;color:#475569;">
                  ${reasoning}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  private static holdPill(s: Signal): string {
    const c = COLORS.HOLD;
    const ticker = TraderAgent.escapeHtml(s.ticker.toUpperCase());
    return `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 10px;border-radius:6px;background:${c.bg};color:${c.fg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;white-space:nowrap;"><strong>${ticker}</strong>&nbsp;&nbsp;${Math.round(s.confidence * 100)}%</span>`;
  }

  private static sectionHeader(label: string, count: number, kind: "BUY" | "SELL" | "HOLD"): string {
    const c = COLORS[kind];
    return `
      <tr>
        <td style="padding:28px 0 12px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:4px;background:${c.border};border-radius:2px;font-size:1px;line-height:18px;">&nbsp;</td>
              <td style="padding-left:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.6px;color:#0f172a;text-transform:uppercase;">
                ${label} <span style="color:#94a3b8;font-weight:600;">(${count})</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  private static statBlock(label: string, count: number, kind: "BUY" | "SELL" | "HOLD"): string {
    const c = COLORS[kind];
    return `
      <td align="center" style="padding:16px 8px;">
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:26px;font-weight:800;color:${c.border};">${count}</div>
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.6px;color:#94a3b8;text-transform:uppercase;margin-top:2px;">${label}</div>
      </td>`;
  }

  static buildEmailHtml(
    buys: Signal[],
    sells: Signal[],
    holds: Signal[],
    date: string
  ): string {
    const buySection = buys.length
      ? TraderAgent.sectionHeader("Buy signals", buys.length, "BUY") +
        buys.map((s) => TraderAgent.signalCard(s, "BUY")).join("")
      : "";
    const sellSection = sells.length
      ? TraderAgent.sectionHeader("Sell signals", sells.length, "SELL") +
        sells.map((s) => TraderAgent.signalCard(s, "SELL")).join("")
      : "";
    const holdSection = holds.length
      ? TraderAgent.sectionHeader("Hold signals", holds.length, "HOLD") +
        `<tr><td style="padding:0 0 16px 0;">${holds.map((s) => TraderAgent.holdPill(s)).join("")}</td></tr>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>fstack Investment Signals</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e6e9ef;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 4px 32px;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:800;letter-spacing:2px;color:#4f46e5;text-transform:uppercase;">fstack</div>
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#0f172a;margin-top:6px;">Investment Signals</div>
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13.5px;color:#64748b;margin-top:4px;">${TraderAgent.escapeHtml(TraderAgent.formatDate(date))}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 0 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef1f5;border-bottom:1px solid #eef1f5;">
                <tr>
                  ${TraderAgent.statBlock("Buy", buys.length, "BUY")}
                  ${TraderAgent.statBlock("Sell", sells.length, "SELL")}
                  ${TraderAgent.statBlock("Hold", holds.length, "HOLD")}
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 8px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${buySection}
                ${sellSection}
                ${holdSection}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 32px 32px;border-top:1px solid #eef1f5;margin-top:8px;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;color:#94a3b8;line-height:1.6;">
                Generated automatically by fstack.<br>
                Do not reply to this email — it is not monitored.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  static buildRetryHtml(signal: Signal): string {
    const kind = (signal.recommendation as "BUY" | "SELL" | "HOLD") ?? "HOLD";
    const c = COLORS[kind] ?? COLORS.HOLD;
    const ticker = TraderAgent.escapeHtml(signal.ticker.toUpperCase());
    const reasoning = TraderAgent.escapeHtml(signal.reasoning);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>fstack retry</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e6e9ef;">
          <tr>
            <td style="padding:24px 28px 8px 28px;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:800;letter-spacing:2px;color:#4f46e5;text-transform:uppercase;">fstack · retry</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 24px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e9ef;border-left:4px solid ${c.border};border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#0f172a;">${ticker}</div>
                    <div style="margin-top:4px;">${TraderAgent.confidencePill(signal.confidence, kind)}</div>
                    <p style="margin:8px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13.5px;line-height:1.5;color:#475569;">${reasoning}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private async sendEmail(subject: string, text: string, html?: string): Promise<boolean> {
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
        text,
        ...(html ? { html } : {}),
      });
      this.logger.info(`Email sent to ${this.notificationEmail}`);
      return true;
    } catch (e) {
      this.logger.error(`Email send failed: ${e}`);
      return false;
    }
  }
}
