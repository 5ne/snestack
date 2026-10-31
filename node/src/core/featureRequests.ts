import * as fs from "fs";
import * as path from "path";

/**
 * Reads feature-request proposal files under `<brain>/<domain>/feature-requests/`
 * (written by the PM role, see `core/skills/pm.md`) and rewrites a proposal's
 * `status` frontmatter field in place for the `feature approve|start|done` CLI
 * commands. Proposals are authored by the PM scheduled script (`scripts/pm-daily.sh`);
 * this module never writes new proposals and never touches source code, skills, or config.
 */

export type Impact = "low" | "medium" | "high";
export type Effort = "small" | "medium" | "large";
export type ProposalStatus = "proposed" | "approved" | "in-progress" | "done";

interface Frontmatter {
  data: Record<string, string>;
  bodyStart: number;
}

function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith("---")) return null;
  const closeIdx = text.indexOf("\n---", 3);
  if (closeIdx === -1) return null;
  const raw = text.slice(3, closeIdx).trim();
  const afterClose = closeIdx + 4; // past "\n---"
  const nl = text.indexOf("\n", afterClose);
  const bodyStart = nl === -1 ? text.length : nl + 1;

  const data: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, bodyStart };
}

export interface ProposalFile {
  file: string;
  /** Filename without extension — used as the CLI's addressing id. */
  slug: string;
  title: string;
  status: ProposalStatus;
  domain: string;
  impact: Impact | null;
  effort: Effort | null;
  created: string | null;
  /** Markdown body after the frontmatter. */
  body: string;
}

export function readProposalFile(file: string): ProposalFile | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const body = text.slice(fm.bodyStart);
  const titleMatch = /^#\s*(.+)$/m.exec(body);
  const slug = path.basename(file, ".md");
  return {
    file,
    slug,
    title: titleMatch ? titleMatch[1].trim() : slug,
    status: (fm.data.status as ProposalStatus) ?? "proposed",
    domain: fm.data.domain ?? "",
    impact: (fm.data.impact as Impact) ?? null,
    effort: (fm.data.effort as Effort) ?? null,
    created: fm.data.created ?? null,
    body,
  };
}

export function featureRequestsDir(brainRoot: string, domain: string): string {
  return path.join(brainRoot, domain, "feature-requests");
}

/** Every proposal file for a domain, any status, sorted by filename (so by date, then slug). */
export function listProposals(brainRoot: string, domain: string): ProposalFile[] {
  const dir = featureRequestsDir(brainRoot, domain);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readProposalFile(path.join(dir, f)))
    .filter((p): p is ProposalFile => p != null)
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Rewrites only the `status:` line in a proposal's frontmatter, in place. Returns false if the file or field is missing. */
export function setProposalStatus(file: string, status: ProposalStatus): boolean {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);
  if (!fm || !("status" in fm.data)) return false;
  const rewritten = text.replace(/^status:.*$/m, `status: ${status}`);
  fs.writeFileSync(file, rewritten, "utf8");
  return true;
}

/** Finds a domain's proposal file by its slug (filename without extension). */
export function findProposalBySlug(brainRoot: string, domain: string, slug: string): ProposalFile | null {
  const file = path.join(featureRequestsDir(brainRoot, domain), `${slug}.md`);
  return readProposalFile(file);
}
