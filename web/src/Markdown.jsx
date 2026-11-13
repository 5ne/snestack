import { Fragment } from "react";

// Safe React-element Markdown renderer (no HTML injection, no dangerouslySetInnerHTML),
// styled after Unison's Markdown.jsx with added Markdown table & frontmatter support
// for snestack skills, company theses, and travel logs.

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,4})[ \t]+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^ {0,3}([-*+]|\d+\.)[ \t]+(.*)$/;
const TABLE_SEP = /^\|?[\s:-]+\|[\s|:-]*$/;

function isRule(line) {
  const s = line.trim();
  return s.length >= 3 && (/^-+$/.test(s) || /^\*+$/.test(s) || /^_+$/.test(s));
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderInline(text, keyPrefix = "in") {
  const str = String(text ?? "");
  const out = [];
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|\*[^*\n]+\*)/g;
  let last = 0;
  let match;
  let idx = 0;
  while ((match = tokenRe.exec(str)) !== null) {
    if (match.index > last) {
      out.push(str.slice(last, match.index));
    }
    const tok = match[0];
    const k = `${keyPrefix}-${idx++}`;
    if (tok.startsWith("**") && tok.endsWith("**")) {
      out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("[")) {
      const closeBracket = tok.indexOf("](");
      const label = tok.slice(1, closeBracket);
      const href = tok.slice(closeBracket + 2, -1);
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>
      );
    } else if (tok.startsWith("*") && tok.endsWith("*")) {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    } else {
      out.push(tok);
    }
    last = match.index + tok.length;
  }
  if (last < str.length) {
    out.push(str.slice(last));
  }
  return out;
}

function parseBlocks(rawText) {
  const normalized = String(rawText ?? "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  let lines = normalized.split("\n");

  // Strip optional YAML frontmatter block at top of markdown
  if (lines[0]?.trim() === "---") {
    const endFm = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (endFm > 0) {
      lines = lines.slice(endFm + 1);
    }
  }

  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1];
      let end = i + 1;
      while (end < lines.length && !lines[end].trim().startsWith(marker)) end++;
      blocks.push({
        type: "code",
        text: lines.slice(i + 1, end).join("\n"),
      });
      i = end + 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())) {
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const qLines = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        qLines.push(lines[i].replace(QUOTE, "$1"));
        i++;
      }
      blocks.push({ type: "quote", text: qLines.join("\n") });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        items.push(lines[i].replace(LIST_ITEM, "$2"));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !isRule(lines[i])
    ) {
      pLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", lines: pLines });
  }
  return blocks;
}

export default function Markdown({ text }) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;

  return (
    <div className="md">
      {blocks.map((b, idx) => {
        if (b.type === "hr") return <hr key={idx} />;
        if (b.type === "code") {
          return (
            <pre key={idx}>
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.type === "heading") {
          const Tag = `h${Math.min(4, Math.max(1, b.level))}`;
          return <Tag key={idx}>{renderInline(b.text, `h-${idx}`)}</Tag>;
        }
        if (b.type === "quote") {
          const lines = b.text.split("\n");
          return (
            <blockquote key={idx}>
              {lines.map((l, li) => (
                <Fragment key={li}>
                  {renderInline(l, `q-${idx}-${li}`)}
                  {li < lines.length - 1 ? <br /> : null}
                </Fragment>
              ))}
            </blockquote>
          );
        }
        if (b.type === "list") {
          const ListTag = b.ordered ? "ol" : "ul";
          return (
            <ListTag key={idx}>
              {b.items.map((item, li) => (
                <li key={li}>{renderInline(item, `li-${idx}-${li}`)}</li>
              ))}
            </ListTag>
          );
        }
        if (b.type === "table") {
          return (
            <div key={idx} className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {b.headers.map((h, hi) => (
                      <th key={hi}>{renderInline(h, `th-${idx}-${hi}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri}>
                      {b.headers.map((_, ci) => (
                        <td key={ci}>{renderInline(r[ci] ?? "", `td-${idx}-${ri}-${ci}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={idx}>
            {b.lines.map((l, li) => (
              <Fragment key={li}>
                {renderInline(l, `p-${idx}-${li}`)}
                {li < b.lines.length - 1 ? <br /> : null}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
