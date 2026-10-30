import nodemailer from "nodemailer";
import { BaseAgent } from "./base";
import { EmailServiceError } from "../../../core/errors";
import type { Signal, EquityData } from "../../../core/models";
import type { Db } from "../../../core/db";
import { formatRunReportText, formatDuration, formatCost, type RunReport } from "../../../core/runReport";

const COLORS: Record<"BUY" | "SELL" | "HOLD", { fg: string; bg: string; border: string }> = {
  BUY: { fg: "#0f7a3d", bg: "#e9f9ef", border: "#16a34a" },
  SELL: { fg: "#b91c1c", bg: "#fdeeee", border: "#dc2626" },
  HOLD: { fg: "#475569", bg: "#f1f5f9", border: "#94a3b8" },
};

// Signals at or above this confidence get called out as "act now" — a direct,
// immediate call to action rather than just another line in the BUY/SELL list.
// Applies to BUY/SELL only: a high-confidence HOLD means "confidently do
// nothing," which isn't something to act on right now the way a BUY/SELL is.
const ACTION_THRESHOLD = 0.75;

type Recommendation = "BUY" | "SELL" | "HOLD";

function isActionable(s: Signal): boolean {
  return (
    (s.recommendation === "BUY" || s.recommendation === "SELL") &&
    s.confidence > ACTION_THRESHOLD
  );
}

function byConfidenceDesc(a: Signal, b: Signal): number {
  return b.confidence - a.confidence;
}

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

  async sendBatchEmail(
    signals: Signal[],
    equities: Record<string, EquityData | null | undefined> = {},
    issues: Record<string, string[]> = {},
    runDate?: string,
    runReport?: RunReport
  ): Promise<boolean> {
    if (signals.length === 0) {
      this.logger.info("No signals to send");
      return true;
    }
    const date = runDate ?? new Date().toISOString().split("T")[0];
    try {
      // Highest confidence first within each group.
      const buys = signals.filter((s) => s.recommendation === "BUY").sort(byConfidenceDesc);
      const sells = signals.filter((s) => s.recommendation === "SELL").sort(byConfidenceDesc);
      const holds = signals.filter((s) => s.recommendation === "HOLD").sort(byConfidenceDesc);
      const actionNow = signals.filter(isActionable).sort(byConfidenceDesc);

      const subject = TraderAgent.buildSubject(buys, sells, holds, actionNow, issues, date);
      const text = TraderAgent.buildEmailBody(buys, sells, holds, actionNow, equities, issues, date, runReport);
      const html = TraderAgent.buildEmailHtml(buys, sells, holds, actionNow, equities, issues, date, runReport);
      const success = await this.sendEmail(subject, text, html);

      if (success) {
        this.logger.info(
          `Email sent: ${signals.length} signals (${buys.length} BUY, ${sells.length} SELL, ` +
            `${holds.length} HOLD, ${actionNow.length} act-now, ${Object.keys(issues).length} with issues)`
        );
        for (const signal of signals) {
          await this.db.addTicker(signal.ticker, signal.ticker, "PUBLIC");
          await this.db.addSignal(
            signal.ticker,
            signal.date.toISOString(),
            signal.recommendation,
            signal.confidence,
            signal.reasoning,
            signal.fromWatchlist
          );
        }
      } else {
        this.logger.warn("Email send failed — signals not recorded");
      }
      return success;
    } catch (e) {
      this.logger.error(`Batch email send failed: ${e}`);
      throw new EmailServiceError(`Batch email failed: ${e}`);
    }
  }

  static buildSubject(
    buys: Signal[],
    sells: Signal[],
    holds: Signal[],
    actionNow: Signal[],
    issues: Record<string, string[]>,
    date: string
  ): string {
    let subject = `snestack analysis ${date} — ${buys.length} BUY, ${sells.length} SELL, ${holds.length} HOLD`;
    if (actionNow.length) subject += ` · ⚡ ${actionNow.length} ACT NOW`;
    const issueCount = Object.keys(issues).length;
    if (issueCount) subject += ` · ⚠ ${issueCount} data issue${issueCount === 1 ? "" : "s"}`;
    return subject;
  }

  // ---------- shared financials formatting (used by both text and HTML) ----------

  private static fmtRatio(v: number | null | undefined, digits = 1): string | null {
    return v != null && isFinite(v) ? v.toFixed(digits) : null;
  }

  private static fmtPct(v: number | null | undefined, digits = 1): string | null {
    return v != null && isFinite(v) ? `${(v * 100).toFixed(digits)}%` : null;
  }

  /** Compact list of "Label value" pairs for whatever fields are actually present. */
  private static financialsFields(equity: EquityData | null | undefined): Array<[string, string]> {
    if (!equity) return [];
    const out: Array<[string, string]> = [];
    const pe = TraderAgent.fmtRatio(equity.peRatio);
    if (pe) out.push(["P/E", pe]);
    const pb = TraderAgent.fmtRatio(equity.pbRatio);
    if (pb) out.push(["P/B", pb]);
    const div = TraderAgent.fmtPct(equity.dividendYield, 2);
    if (div) out.push(["Div Yield", div]);
    const de = TraderAgent.fmtRatio(equity.debtToEquity, 2);
    if (de) out.push(["D/E", de]);
    const fcfYield = TraderAgent.fmtPct(equity.fcfYield);
    if (fcfYield) out.push(["FCF Yield", fcfYield]);
    const eg = TraderAgent.fmtPct(equity.earningsGrowth);
    if (eg) out.push(["EPS Growth", equity.earningsGrowth! >= 0 ? `+${eg}` : eg]);
    const rg = TraderAgent.fmtPct(equity.revenueGrowth);
    if (rg) out.push(["Rev Growth", equity.revenueGrowth! >= 0 ? `+${rg}` : rg]);
    return out;
  }

  /** Morningstar's own analyst view — fair value, moat, star rating — has no real-time equivalent. */
  private static analystFields(equity: EquityData | null | undefined): string | null {
    if (!equity) return null;
    const parts: string[] = [];
    if (equity.fairValue != null) {
      const pfve = equity.priceToFairValue != null ? ` (${equity.priceToFairValue.toFixed(2)}x)` : "";
      parts.push(`Fair Value $${equity.fairValue.toFixed(2)}${pfve}`);
    }
    if (equity.economicMoat) parts.push(`${equity.economicMoat} Moat`);
    if (equity.morningstarRating != null) {
      parts.push("★".repeat(equity.morningstarRating) + "☆".repeat(5 - equity.morningstarRating));
    }
    return parts.length ? parts.join("  ·  ") : null;
  }

  static buildEmailBody(
    buys: Signal[],
    sells: Signal[],
    holds: Signal[],
    actionNow: Signal[],
    equities: Record<string, EquityData | null | undefined>,
    issues: Record<string, string[]>,
    date: string,
    runReport?: RunReport
  ): string {
    const lines: string[] = [
      "snestack Investment Analysis",
      "=".repeat(50),
      `Date: ${date}`,
      "",
    ];

    if (Object.keys(issues).length) {
      lines.push(
        `!!! DATA & ANALYSIS ISSUES (${Object.keys(issues).length}) !!!`,
        "-".repeat(50),
        "Recommendations below for these tickers were made with incomplete data",
        "or a fallback value — treat them with extra caution.",
        ""
      );
      for (const [ticker, msgs] of Object.entries(issues)) {
        lines.push(`${ticker}: ${msgs.join("; ")}`);
      }
      lines.push("");
    }

    const writeSignal = (s: Signal, withFinancials: boolean) => {
      lines.push(
        s.ticker.toUpperCase(),
        `  Confidence: ${(s.confidence * 100).toFixed(0)}%`,
        `  Reason: ${s.reasoning}`
      );
      if (withFinancials) {
        const equity = equities[s.ticker];
        const fields = TraderAgent.financialsFields(equity);
        if (fields.length) {
          lines.push(`  Financials: ${fields.map(([k, v]) => `${k} ${v}`).join("  ")}`);
        }
        const analyst = TraderAgent.analystFields(equity);
        if (analyst) lines.push(`  Morningstar: ${analyst}`);
        if (equity?.redFlags.length) {
          lines.push(`  Red flags: ${equity.redFlags.join("; ")}`);
        }
      }
      if (issues[s.ticker]?.length) {
        lines.push(`  ⚠ Issues: ${issues[s.ticker].join("; ")}`);
      }
      lines.push("");
    };

    if (actionNow.length) {
      lines.push(
        `>>> ACT NOW — confidence over ${(ACTION_THRESHOLD * 100).toFixed(0)}% <<<`,
        "-".repeat(50)
      );
      for (const s of actionNow) {
        lines.push(`[${s.recommendation}]`);
        writeSignal(s, true);
      }
    }

    if (buys.length) {
      lines.push("BUY SIGNALS", "-".repeat(50));
      for (const s of buys) writeSignal(s, true);
    }
    if (sells.length) {
      lines.push("SELL SIGNALS", "-".repeat(50));
      for (const s of sells) writeSignal(s, true);
    }
    if (holds.length) {
      lines.push("HOLD SIGNALS", "-".repeat(50));
      for (const s of holds) {
        const flag = issues[s.ticker]?.length ? " ⚠" : "";
        lines.push(`${s.ticker.toUpperCase()} (${(s.confidence * 100).toFixed(0)}%)${flag}`);
      }
      lines.push("");
    }
    if (runReport) lines.push("=".repeat(50), formatRunReportText(runReport), "");
    lines.push("=".repeat(50), "Generated by snestack", "Do not reply to this email");
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

  private static confidencePill(confidence: number, kind: Recommendation): string {
    const c = COLORS[kind];
    const pct = Math.round(confidence * 100);
    return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${c.bg};color:${c.fg};font-size:12px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${pct}% confidence</span>`;
  }

  /** Data/analysis-pipeline problems for this ticker — distinct from red flags (which are
   *  about the company's fundamentals, not about our system failing to fetch/parse something). */
  private static issuesHtml(ticker: string, issues: Record<string, string[]>): string {
    const msgs = issues[ticker];
    if (!msgs?.length) return "";
    const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
    return `<div style="margin-top:6px;${font}font-size:11.5px;color:#6d28d9;">⚠ ${TraderAgent.escapeHtml(msgs.join("; "))}</div>`;
  }

  private static financialsHtml(equity: EquityData | null | undefined): string {
    if (!equity) return "";
    const fields = TraderAgent.financialsFields(equity);
    const analyst = TraderAgent.analystFields(equity);
    const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
    let out = "";
    if (fields.length) {
      const chips = fields
        .map(
          ([k, v]) =>
            `<span style="display:inline-block;margin:4px 6px 0 0;padding:2px 8px;border-radius:5px;background:#f8fafc;border:1px solid #eef1f5;${font}font-size:11.5px;color:#334155;"><span style="color:#94a3b8;">${TraderAgent.escapeHtml(k)}</span> ${TraderAgent.escapeHtml(v)}</span>`
        )
        .join("");
      out += `<div style="margin-top:8px;">${chips}</div>`;
    }
    if (analyst) {
      out += `<div style="margin-top:6px;${font}font-size:11.5px;color:#94a3b8;">${TraderAgent.escapeHtml(analyst)}</div>`;
    }
    if (equity.redFlags.length) {
      out += `<div style="margin-top:6px;${font}font-size:11.5px;color:#b45309;">⚠ ${TraderAgent.escapeHtml(equity.redFlags.join("; "))}</div>`;
    }
    return out;
  }

  private static signalCard(
    s: Signal,
    kind: Recommendation,
    equities: Record<string, EquityData | null | undefined>,
    issues: Record<string, string[]>
  ): string {
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
                ${TraderAgent.financialsHtml(equities[s.ticker])}
                ${TraderAgent.issuesHtml(s.ticker, issues)}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  /** Same as signalCard but with a bold "act now" badge instead of the plain ticker treatment. */
  private static actionCard(
    s: Signal,
    equities: Record<string, EquityData | null | undefined>,
    issues: Record<string, string[]>
  ): string {
    const kind = s.recommendation as "BUY" | "SELL";
    const c = COLORS[kind];
    const ticker = TraderAgent.escapeHtml(s.ticker.toUpperCase());
    const reasoning = TraderAgent.escapeHtml(s.reasoning);
    const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
    return `
      <tr>
        <td style="padding:0 0 12px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #d97706;border-radius:8px;">
            <tr>
              <td style="padding:14px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td>
                      <span style="display:inline-block;padding:3px 9px;border-radius:5px;background:${c.border};color:#ffffff;${font}font-size:11px;font-weight:800;letter-spacing:0.4px;">${kind} NOW</span>
                      <span style="${font}font-size:16px;font-weight:700;color:#0f172a;margin-left:8px;">${ticker}</span>
                    </td>
                    <td align="right">${TraderAgent.confidencePill(s.confidence, kind)}</td>
                  </tr>
                </table>
                <p style="margin:8px 0 0 0;${font}font-size:13.5px;line-height:1.5;color:#475569;">
                  ${reasoning}
                </p>
                ${TraderAgent.financialsHtml(equities[s.ticker])}
                ${TraderAgent.issuesHtml(s.ticker, issues)}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  private static holdPill(s: Signal, issues: Record<string, string[]>): string {
    const flagged = !!issues[s.ticker]?.length;
    const c = COLORS.HOLD;
    const ticker = TraderAgent.escapeHtml(s.ticker.toUpperCase());
    const bg = flagged ? "#f5f3ff" : c.bg;
    const fg = flagged ? "#6d28d9" : c.fg;
    const border = flagged ? "border:1px solid #ddd6fe;" : "";
    const warn = flagged ? "⚠ " : "";
    return `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 10px;border-radius:6px;background:${bg};${border}color:${fg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;white-space:nowrap;">${warn}<strong>${ticker}</strong>&nbsp;&nbsp;${Math.round(s.confidence * 100)}%</span>`;
  }

  private static sectionHeader(label: string, count: number, kind: Recommendation): string {
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

  private static statBlock(label: string, count: number, kind: Recommendation): string {
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
    actionNow: Signal[],
    equities: Record<string, EquityData | null | undefined>,
    issues: Record<string, string[]>,
    date: string,
    runReport?: RunReport
  ): string {
    const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

    const issueEntries = Object.entries(issues);
    const issuesSection = issueEntries.length
      ? `
      <tr>
        <td style="padding:16px 0 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;">
            <tr>
              <td style="padding:12px 16px;">
                <div style="${font}font-size:12px;font-weight:800;letter-spacing:0.5px;color:#6d28d9;text-transform:uppercase;">
                  ⚠ Data &amp; analysis issues (${issueEntries.length})
                </div>
                <div style="margin-top:6px;${font}font-size:12px;color:#5b21b6;line-height:1.7;">
                  ${issueEntries
                    .map(
                      ([ticker, msgs]) =>
                        `<strong>${TraderAgent.escapeHtml(ticker)}</strong> — ${TraderAgent.escapeHtml(msgs.join("; "))}`
                    )
                    .join("<br>")}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
      : "";

    const actionSection = actionNow.length
      ? `
      <tr>
        <td style="padding:20px 0 4px 0;">
          <div style="${font}font-size:13px;font-weight:800;letter-spacing:0.6px;color:#b45309;text-transform:uppercase;">
            ⚡ Act now — confidence over ${(ACTION_THRESHOLD * 100).toFixed(0)}%
          </div>
        </td>
      </tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${actionNow.map((s) => TraderAgent.actionCard(s, equities, issues)).join("")}
      </table></td></tr>`
      : "";

    const buySection = buys.length
      ? TraderAgent.sectionHeader("Buy signals", buys.length, "BUY") +
        buys.map((s) => TraderAgent.signalCard(s, "BUY", equities, issues)).join("")
      : "";
    const sellSection = sells.length
      ? TraderAgent.sectionHeader("Sell signals", sells.length, "SELL") +
        sells.map((s) => TraderAgent.signalCard(s, "SELL", equities, issues)).join("")
      : "";
    const holdSection = holds.length
      ? TraderAgent.sectionHeader("Hold signals", holds.length, "HOLD") +
        `<tr><td style="padding:0 0 16px 0;">${holds.map((s) => TraderAgent.holdPill(s, issues)).join("")}</td></tr>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>snestack Investment Signals</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e6e9ef;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 4px 32px;">
              <div style="${font}font-size:12px;font-weight:800;letter-spacing:2px;color:#4f46e5;text-transform:uppercase;">snestack</div>
              <div style="${font}font-size:22px;font-weight:800;color:#0f172a;margin-top:6px;">Investment Signals</div>
              <div style="${font}font-size:13.5px;color:#64748b;margin-top:4px;">${TraderAgent.escapeHtml(TraderAgent.formatDate(date))}</div>
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
                ${issuesSection}
                ${actionSection}
                ${buySection}
                ${sellSection}
                ${holdSection}
              </table>
            </td>
          </tr>
          ${
            runReport
              ? `<tr><td style="padding:8px 32px 20px 32px;${font}font-size:13px;line-height:1.55;color:#334155;border-top:1px solid #eef1f5;">${TraderAgent.runSummaryHtml(runReport)}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:24px 32px 32px 32px;border-top:1px solid #eef1f5;margin-top:8px;">
              <div style="${font}font-size:11.5px;color:#94a3b8;line-height:1.6;">
                Generated automatically by snestack.<br>
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

  /** The "Job run summary" section as HTML (shared by the recommendations email and the no-changes email). */
  private static runSummaryHtml(report: RunReport): string {
    const esc = TraderAgent.escapeHtml;
    const rows = (items: string[]) => items.map((i) => `<li style="margin:2px 0;">${i}</li>`).join("");
    return `
        <div style="font-weight:700;color:#0f172a;margin-bottom:6px;">Job run summary</div>
<div>Status: <b>${esc(report.status.toUpperCase())}</b> · ${esc(formatDuration(report.durationMs))}${report.dryRun ? " · dry run" : ""}</div>
<div>Checked ${report.subjects} ticker${report.subjects === 1 ? "" : "s"}: ${report.ran} analysis call${report.ran === 1 ? "" : "s"} ran, ${report.skipped.length} skipped because nothing had changed.</div>
<div>Model usage: ${report.totals.calls} call${report.totals.calls === 1 ? "" : "s"}, ${report.totals.inputTokens.toLocaleString("en-US")} tokens in / ${report.totals.outputTokens.toLocaleString("en-US")} out, est. cost ${esc(formatCost(report.totals.costUsd))}</div>
${
  report.status === "failed" && report.failures.length === 0
    ? `<div style="font-weight:700;color:#b91c1c;margin-top:12px;">The script stopped early (exit code ${esc(String(report.scriptExitCode ?? "unknown"))}) before any step reported a failure; see the run logs.</div>`
    : ""
}
${
  report.failures.length
    ? `<div style="font-weight:700;color:#b91c1c;margin-top:12px;">Problems (${report.failures.length})</div><ul style="margin:4px 0 0 18px;padding:0;">${rows(
        report.failures.map(
          (f) =>
            `${esc(f.step)}${f.subject && f.subject !== "all" ? " " + esc(f.subject) : ""}: ${esc(f.error ?? `exit ${f.exit_code}`)}`
        )
      )}</ul>`
    : ""
}
${
  report.truncations.length
    ? `<div style="font-weight:700;color:#b45309;margin-top:12px;">Cut off at the token limit (${report.truncations.length})</div><ul style="margin:4px 0 0 18px;padding:0;">${rows(
        report.truncations.map((t) => `${esc(t.step)}${t.subject ? " " + esc(t.subject) : ""}`)
      )}</ul>`
    : ""
}
${
  report.calls.length
    ? `<div style="font-weight:700;color:#0f172a;margin-top:12px;">Analysis that ran</div><ul style="margin:4px 0 0 18px;padding:0;">${rows(
        report.calls.map(
          (c) =>
            `${esc(c.label)}: ${c.inputTokens.toLocaleString("en-US")} in / ${c.outputTokens.toLocaleString("en-US")} out, ${(c.latencyMs / 1000).toFixed(1)}s, ${esc(formatCost(c.costUsd))}${c.error ? ` — ERROR: ${esc(c.error.slice(0, 160))}` : ""}`
        )
      )}</ul>`
    : ""
}
${
  report.skipped.length
    ? `<div style="font-weight:700;color:#0f172a;margin-top:12px;">Skipped (no model call needed)</div><ul style="margin:4px 0 0 18px;padding:0;color:#64748b;">${rows(
        report.skipped.map((s) => `${esc(s.subject)} ${esc(s.skill)}: ${esc(s.reason)}`)
      )}</ul>`
    : ""
}
`;
  }

  /**
   * Subject, plain text and HTML for the email sent when a run has no new
   * recommendations ("no changes") or didn't complete cleanly ("problems"),
   * followed by a summary of the job run built from its logs.
   */
  static buildRunSummaryEmail(report: RunReport, date: string): { subject: string; text: string; html: string } {
    const problems = report.status === "failed";
    const headline = problems
      ? "The analysis run had problems, so no new recommendations were produced."
      : "No changes today. Nothing crossed a trigger, so there are no new recommendations.";
    const subject = problems
      ? `snestack ${date} — run had problems (see details)`
      : `snestack ${date} — no changes${report.status === "degraded" ? " (with warnings)" : ""}`;
    const text = `${headline}\n\n${formatRunReportText(report)}\n`;

    const esc = TraderAgent.escapeHtml;
    const rows = (items: string[]) => items.map((i) => `<li style="margin:2px 0;">${i}</li>`).join("");
    const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
    const accent = problems ? "#dc2626" : "#16a34a";
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>snestack run summary</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e6e9ef;">
      <tr><td style="padding:24px 28px 4px 28px;${font}font-size:12px;font-weight:800;letter-spacing:2px;color:#4f46e5;text-transform:uppercase;">snestack · ${esc(date)}</td></tr>
      <tr><td style="padding:8px 28px 16px 28px;"><div style="border-left:4px solid ${accent};padding:10px 14px;background:#f8fafc;border-radius:6px;${font}font-size:15px;font-weight:600;color:#0f172a;">${esc(headline)}</div></td></tr>
      <tr><td style="padding:0 28px 20px 28px;${font}font-size:13.5px;line-height:1.55;color:#334155;">
        ${TraderAgent.runSummaryHtml(report)}
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
    return { subject, text, html };
  }

  /** Send the "no changes" / "run had problems" email for a run. */
  async sendRunSummaryEmail(report: RunReport, date?: string): Promise<boolean> {
    const { subject, text, html } = TraderAgent.buildRunSummaryEmail(report, date ?? new Date().toISOString().split("T")[0]);
    return this.sendEmail(subject, text, html);
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
