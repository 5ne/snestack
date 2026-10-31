import type { ProposalFile } from "./featureRequests";

export type Role = "pm" | "eng";

export interface RoleEmailInput {
  role: Role;
  /** The agent session (or its gate/setup) failed; `failureReason` is a short tail of its stderr / error text. */
  failed: boolean;
  failureReason?: string | null;
  /** The session's final message (report.md). */
  report: string;
  /** PM only: proposals that exist now but did not exist before the session started. */
  newProposals?: ProposalFile[];
  /** Eng only: lines of the auto-merge log (`- <id>: MERGED ...` / `- <id>: NOT auto-merged ...`). */
  mergeLog?: string;
  /** Date shown in the header (YYYY-MM-DD); defaults to today. */
  date?: string;
}

export interface RoleEmail {
  subject: string;
  text: string;
  html: string;
}

const REPORT_EXCERPT_CHARS = 3000;
// Same look as the financial signals email (domains/financial/agents/traderAgent.ts).
const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const MONO = "font-family:SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;";

function excerpt(text: string): string {
  const t = text.trim();
  return t.length > REPORT_EXCERPT_CHARS ? `${t.slice(0, REPORT_EXCERPT_CHARS)}\n…(truncated; full report in the run folder)` : t;
}

export function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, `<span style="${MONO}font-size:12px;background:#f1f5f9;border-radius:4px;padding:1px 5px;color:#334155;">$1</span>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#0f172a;">$1</strong>');
}

/** A deliberately small Markdown renderer for agent reports: headings, bullets, numbered lists, **bold**, `code`, paragraphs. */
export function renderMarkdownLite(md: string): string {
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flush = (): void => {
    if (!list) return;
    out.push(
      `<${list.tag} style="margin:6px 0 10px 0;padding-left:20px;">${list.items.map((i) => `<li style="margin:3px 0;">${i}</li>`).join("")}</${list.tag}>`
    );
    list = null;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      list.items.push(inline(escapeHtml((bullet ?? numbered)![1])));
      continue;
    }
    flush();
    if (heading) {
      out.push(`<div style="margin:14px 0 4px 0;font-weight:700;color:#0f172a;">${inline(escapeHtml(heading[1]))}</div>`);
    } else if (line.trim()) {
      out.push(`<p style="margin:6px 0;">${inline(escapeHtml(line))}</p>`);
    }
  }
  flush();
  return out.join("\n");
}

function chip(label: string, bg: string, fg: string): string {
  return `<span style="display:inline-block;margin:0 6px 0 0;padding:2px 9px;border-radius:999px;background:${bg};color:${fg};${FONT}font-size:11px;font-weight:700;">${escapeHtml(label)}</span>`;
}

function stat(count: number, label: string, color: string): string {
  return `<td align="center" style="padding:16px 8px;">
    <div style="${FONT}font-size:26px;font-weight:800;color:${color};">${count}</div>
    <div style="${FONT}font-size:11px;font-weight:700;letter-spacing:0.6px;color:#94a3b8;text-transform:uppercase;margin-top:2px;">${escapeHtml(label)}</div>
  </td>`;
}

function card(border: string, bg: string, borderColor: string, inner: string): string {
  return `<tr><td style="padding:0 0 12px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border:1px solid ${borderColor};border-left:4px solid ${border};border-radius:8px;">
      <tr><td style="padding:14px 16px;">${inner}</td></tr>
    </table>
  </td></tr>`;
}

function sectionLabel(label: string, color: string): string {
  return `<tr><td style="padding:22px 0 12px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="width:4px;background:${color};border-radius:2px;font-size:1px;line-height:18px;">&nbsp;</td>
      <td style="padding-left:10px;${FONT}font-size:13px;font-weight:700;letter-spacing:0.6px;color:#0f172a;text-transform:uppercase;">${escapeHtml(label)}</td>
    </tr></table>
  </td></tr>`;
}

function page(title: string, dateLabel: string, stats: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e6e9ef;overflow:hidden;">
        <tr><td style="padding:32px 32px 4px 32px;">
          <div style="${FONT}font-size:12px;font-weight:800;letter-spacing:2px;color:#4f46e5;text-transform:uppercase;">snestack</div>
          <div style="${FONT}font-size:22px;font-weight:800;color:#0f172a;margin-top:6px;">${escapeHtml(title)}</div>
          <div style="${FONT}font-size:13.5px;color:#64748b;margin-top:4px;">${escapeHtml(dateLabel)}</div>
        </td></tr>
        ${
          stats
            ? `<tr><td style="padding:8px 24px 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef1f5;border-bottom:1px solid #eef1f5;"><tr>${stats}</tr></table></td></tr>`
            : ""
        }
        <tr><td style="padding:0 32px 8px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table></td></tr>
        <tr><td style="padding:24px 32px 32px 32px;border-top:1px solid #eef1f5;">
          <div style="${FONT}font-size:11.5px;color:#94a3b8;line-height:1.6;">Generated automatically by snestack.<br>Do not reply to this email — it is not monitored.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function reportPanel(label: string, report: string): string {
  // The section label already names the report, so drop a repeated leading "# Title" line.
  const body = excerpt(report).replace(/^\s*#{1,6}\s+[^\n]*\n+/, "");
  if (!body.trim()) return "";
  return `${sectionLabel(label, "#94a3b8")}<tr><td style="${FONT}font-size:13px;line-height:1.55;color:#334155;padding-bottom:12px;">${renderMarkdownLite(body)}</td></tr>`;
}

function dateLabel(date?: string): string {
  const d = new Date(`${date ?? new Date().toISOString().slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? (date ?? "")
    : d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

interface MergeItem {
  id: string;
  merged: boolean;
  detail: string[];
}

/** Parses the eng auto-merge log: "- <id>: MERGED ..." / "- <id>: NOT auto-merged ...", with indented detail lines. */
export function parseMergeLog(log: string): MergeItem[] {
  const items: MergeItem[] = [];
  for (const line of log.split("\n")) {
    const m = /^-\s+(\S+?):\s+(.*)$/.exec(line);
    if (m) {
      items.push({ id: m[1], merged: /^MERGED/.test(m[2]), detail: [m[2]] });
    } else if (items.length && line.trim()) {
      items[items.length - 1].detail.push(line.trim());
    }
  }
  return items;
}

/**
 * Builds the email for a finished PM or eng run, or null when there is nothing worth the owner's attention
 * (a PM run that wrote no new proposals; silence on a quiet day, same rule the old reflect-notify followed).
 * A failed run always produces an email: a usage limit or expired login must not fail silently.
 */
export function buildRoleEmail(input: RoleEmailInput): RoleEmail | null {
  const label = input.role === "pm" ? "PM" : "eng";
  const when = dateLabel(input.date);

  if (input.failed) {
    const reason = (input.failureReason ?? "").trim() || "no error text captured";
    const limit = /usage limit|rate limit/i.test(reason);
    const hint = limit ? "The Claude subscription hit its usage limit. Nothing was lost; the next scheduled run tries again." : "The next scheduled run will try again.";
    const body = card(
      "#dc2626",
      "#fef2f2",
      "#fecaca",
      `<div style="${FONT}font-size:15px;font-weight:700;color:#991b1b;">The ${label} run failed</div>
       <p style="margin:6px 0 10px 0;${FONT}font-size:13.5px;line-height:1.5;color:#7f1d1d;">${escapeHtml(hint)}</p>
       <div style="${MONO}font-size:12px;line-height:1.5;color:#475569;background:#ffffff;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(reason.slice(-1500))}</div>`
    );
    return {
      subject: `snestack ${label}: run FAILED${limit ? " (usage limit)" : ""}`,
      text: `The ${label} run failed${limit ? " (subscription usage limit; the next run retries)" : ""}.\n\n${reason.slice(-1500)}\n`,
      html: page(`${label} run failed`, when, "", body),
    };
  }

  if (input.role === "pm") {
    const proposals = input.newProposals ?? [];
    if (proposals.length === 0) return null;
    const auto = proposals.filter((p) => p.autoApproved);
    const mine = proposals.filter((p) => !p.autoApproved);
    const impactColor = (v: string | null): [string, string] => (v === "high" ? ["#fee2e2", "#991b1b"] : v === "medium" ? ["#fef3c7", "#92400e"] : ["#dcfce7", "#166534"]);

    const cards = (list: ProposalFile[], isAuto: boolean): string =>
      list
        .map((p) => {
          const [ibg, ifg] = impactColor(p.impact);
          const cmd = `snestack feature approve ${p.slug}${p.domain === "_system" ? " --domain _system" : ""}`;
          const action = isAuto
            ? `<p style="margin:10px 0 0 0;${FONT}font-size:12.5px;line-height:1.5;color:#166534;">Auto-approved by the low-risk policy. Eng builds it at the next run and merges only if tests pass and it touches just tests, docs or run-check.</p>`
            : `<div style="margin-top:10px;${MONO}font-size:12px;color:#334155;background:#f8fafc;border:1px solid #eef1f5;border-radius:6px;padding:8px 10px;word-break:break-all;">${escapeHtml(cmd)}</div>`;
          return card(
            isAuto ? "#16a34a" : "#4f46e5",
            "#ffffff",
            "#e6e9ef",
            `<div style="${FONT}font-size:15px;font-weight:700;color:#0f172a;">${escapeHtml(p.title)}</div>
             <div style="margin-top:8px;">${chip(p.domain || "?", "#eef2ff", "#4338ca")}${chip(`impact: ${p.impact ?? "?"}`, ibg, ifg)}${chip(`effort: ${p.effort ?? "?"}`, "#f1f5f9", "#475569")}</div>
             ${action}`
          );
        })
        .join("");

    const body =
      (mine.length ? sectionLabel(`Needs your approval (${mine.length})`, "#4f46e5") + cards(mine, false) : "") +
      (auto.length ? sectionLabel(`Auto-approved (${auto.length})`, "#16a34a") + cards(auto, true) : "") +
      reportPanel("PM notes", input.report);
    const stats = stat(proposals.length, "New", "#4f46e5") + stat(mine.length, "Need approval", "#d97706") + stat(auto.length, "Auto-approved", "#16a34a");

    const lines: string[] = [];
    for (const p of proposals) {
      lines.push(`[${p.domain || "?"}] ${p.title} (impact=${p.impact ?? "?"}, effort=${p.effort ?? "?"})`);
      lines.push(
        p.autoApproved
          ? "  AUTO-APPROVED (low-risk policy): eng builds it next run and merges only if tests pass and it touches just tests/docs/run-check"
          : `  snestack feature approve ${p.slug}${p.domain === "_system" ? " --domain _system" : ""}`
      );
      lines.push("");
    }
    return {
      subject: `snestack PM: ${proposals.length} new feature ${proposals.length === 1 ? "request" : "requests"}`,
      text: `${lines.join("\n")}\nPM report:\n${excerpt(input.report)}\n`,
      html: page("New feature requests", when, stats, body),
    };
  }

  // eng sessions only start when something was approved, so a finished run is always worth a note.
  const items = parseMergeLog(input.mergeLog ?? "");
  const merged = items.filter((i) => i.merged);
  const review = items.filter((i) => !i.merged);
  const itemCards = (list: MergeItem[], ok: boolean): string =>
    list
      .map((i) =>
        card(
          ok ? "#16a34a" : "#d97706",
          ok ? "#ffffff" : "#fffbeb",
          ok ? "#e6e9ef" : "#fde68a",
          `<div style="${FONT}font-size:14px;font-weight:700;color:#0f172a;word-break:break-word;">${escapeHtml(i.id)}</div>
           <div style="margin-top:6px;${FONT}font-size:12.5px;line-height:1.5;color:${ok ? "#166534" : "#92400e"};">${i.detail.map((d) => escapeHtml(d)).join("<br>")}</div>`
        )
      )
      .join("");
  const body =
    (merged.length ? sectionLabel(`Merged to main (${merged.length})`, "#16a34a") + itemCards(merged, true) : "") +
    (review.length ? sectionLabel(`Left for your review (${review.length})`, "#d97706") + itemCards(review, false) : "") +
    reportPanel("Eng report", input.report || "(the session produced no final message)");
  const stats = items.length ? stat(merged.length, "Merged", "#16a34a") + stat(review.length, "Need review", "#d97706") : "";
  const mergeText = items.length ? `\nAuto-merge:\n${input.mergeLog!.trim()}\n` : "";
  return {
    subject: items.length
      ? `snestack eng: ${merged.length} merged, ${review.length} need review`
      : "snestack eng: run finished",
    text: `${excerpt(input.report) || "(the session produced no final message)"}\n${mergeText}`,
    html: page("Eng run finished", when, stats, body),
  };
}
