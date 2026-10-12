import * as fs from "fs";
import * as path from "path";
import { dayString } from "./runCheck";

/**
 * Deterministic half of the `improve-self` reflection loop: parses an
 * `improve-self` skill's free-form write-up into proposals, writes each as its
 * own file under `<brain>/<domain>/feature-requests/`, and rewrites a
 * proposal's `status` frontmatter field in place for the approve/done CLI
 * commands. The skill's judgment ends once it writes a `## Feature Request:`
 * section; everything from there is deterministic, same split as
 * `core/verdict.ts` keeps between judgment and parsing.
 *
 * Safety line: this module only ever writes new files under
 * `feature-requests/`, or edits one of those files' own frontmatter. It never
 * touches source code, skills, or config.
 */

export type Impact = "low" | "medium" | "high";
export type Effort = "small" | "medium" | "large";
export type ProposalStatus = "proposed" | "in-progress" | "done";

export interface Proposal {
  title: string;
  impact: Impact;
  effort: Effort;
  evidence: string;
  /** Free body text after the Impact/Effort/Evidence field block, as written by the skill. */
  body: string;
}

export interface ProposalParseError {
  title: string;
  raw: string;
  reason: string;
}

export interface ParseResult {
  proposals: Proposal[];
  errors: ProposalParseError[];
}

const SECTION_HEADER = /^##\s*Feature Request:\s*(.+?)\s*$/gm;
const IMPACT_LINE = /^\s*\**Impact:\**\s*(low|medium|high)\s*\**\s*$/i;
const EFFORT_LINE = /^\s*\**Effort:\**\s*(small|medium|large)\s*\**\s*$/i;
const EVIDENCE_LINE = /^\s*\**Evidence:\**\s*(.+)$/i;

function parseFieldBlock(section: string): { impact: Impact; effort: Effort; evidence: string; body: string } | null {
  let impact: Impact | null = null;
  let effort: Effort | null = null;
  let evidence: string | null = null;
  const bodyLines: string[] = [];

  for (const line of section.split("\n")) {
    const impactMatch = IMPACT_LINE.exec(line);
    const effortMatch = EFFORT_LINE.exec(line);
    const evidenceMatch = EVIDENCE_LINE.exec(line);
    if (impact == null && impactMatch) {
      impact = impactMatch[1].toLowerCase() as Impact;
      continue;
    }
    if (effort == null && effortMatch) {
      effort = effortMatch[1].toLowerCase() as Effort;
      continue;
    }
    if (evidence == null && evidenceMatch) {
      evidence = evidenceMatch[1].trim();
      continue;
    }
    bodyLines.push(line);
  }

  if (impact == null || effort == null || evidence == null) return null;
  return { impact, effort, evidence, body: bodyLines.join("\n").trim() };
}

/**
 * Splits a skill's write-up on `## Feature Request: <title>` headers. Zero
 * sections is valid (a quiet day). A section missing a well-formed
 * Impact/Effort/Evidence field block is a parse error to surface, not a
 * silent drop and not a silent guess.
 */
export function parseProposals(skillOutput: string): ParseResult {
  const proposals: Proposal[] = [];
  const errors: ProposalParseError[] = [];
  const matches = [...skillOutput.matchAll(SECTION_HEADER)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const title = m[1].trim();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : skillOutput.length;
    const section = skillOutput.slice(start, end).trim();
    const parsed = parseFieldBlock(section);
    if (!parsed) {
      errors.push({ title, raw: section, reason: "missing or malformed Impact/Effort/Evidence field block" });
      continue;
    }
    proposals.push({ title, ...parsed });
  }

  return { proposals, errors };
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "proposal";
}

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "what"]);

function tokenize(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Cheap token-overlap similarity — doesn't need to be clever, just needs to
 * catch a reworded title for the same underlying issue.
 */
export function isLikelyDuplicateTitle(a: string, b: string): boolean {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const overlap = [...ta].filter((t) => tb.has(t)).length;
  return overlap / Math.min(ta.size, tb.size) >= 0.6;
}

interface Frontmatter {
  data: Record<string, string>;
  /** Index into the original text right after the closing `---` line. */
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

export interface WrittenProposal {
  proposal: Proposal;
  /** Absolute path written, or null if skipped as a likely duplicate. */
  file: string | null;
  /** Set when skipped — the existing file this proposal looked like a duplicate of. */
  skippedAsDuplicateOf?: string;
}

/**
 * Writes each proposal as its own file, skipping (and reporting, not
 * silently dropping) any that look like a near-duplicate of an existing
 * proposed/in-progress proposal — the skill is told about existing proposals
 * too, but a model can still duplicate despite being told not to.
 */
export function writeProposals(
  brainRoot: string,
  domain: string,
  proposals: Proposal[],
  opts: { now?: Date } = {}
): WrittenProposal[] {
  const dir = featureRequestsDir(brainRoot, domain);
  fs.mkdirSync(dir, { recursive: true });
  const now = opts.now ?? new Date();
  const date = dayString(now);

  const live = listProposals(brainRoot, domain).filter((p) => p.status === "proposed" || p.status === "in-progress");
  const results: WrittenProposal[] = [];

  for (const proposal of proposals) {
    const dup = live.find((e) => isLikelyDuplicateTitle(e.title, proposal.title));
    if (dup) {
      results.push({ proposal, file: null, skippedAsDuplicateOf: dup.file });
      continue;
    }

    const filename = `${date}-${slugify(proposal.title)}.md`;
    const file = path.join(dir, filename);
    const frontmatter = [
      "---",
      "status: proposed",
      `domain: ${domain}`,
      `impact: ${proposal.impact}`,
      `effort: ${proposal.effort}`,
      `created: ${date}`,
      "source: improve-self",
      "---",
      "",
    ].join("\n");
    const body = `# ${proposal.title}\n\nEvidence: ${proposal.evidence}\n\n${proposal.body}`.trim() + "\n";
    fs.writeFileSync(file, frontmatter + body, "utf8");

    results.push({ proposal, file });
    live.push({
      file,
      slug: path.basename(file, ".md"),
      title: proposal.title,
      status: "proposed",
      domain,
      impact: proposal.impact,
      effort: proposal.effort,
      created: date,
      body,
    });
  }

  return results;
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
