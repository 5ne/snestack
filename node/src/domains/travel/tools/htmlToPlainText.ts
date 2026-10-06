/**
 * Minimal, deterministic HTML-to-text conversion for email bodies. Not a
 * general-purpose HTML parser — just enough to turn a booking-confirmation
 * email into readable text: strip tags/scripts/styles, decode the handful of
 * entities that actually show up, and collapse the long unbroken
 * tracking-link tokens (the thing that made full-body email reads so
 * token-expensive earlier) down to a short placeholder instead of dropping
 * them silently, so it's clear something was there.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\S{80,}/g, "[long link omitted]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cap extracted text to a character budget, keeping the head — confirmation details sit near the top; legal boilerplate is at the bottom. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[truncated]";
}
