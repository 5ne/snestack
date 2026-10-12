import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseProposals,
  slugify,
  isLikelyDuplicateTitle,
  writeProposals,
  listProposals,
  readProposalFile,
  setProposalStatus,
  findProposalBySlug,
  type Proposal,
} from "../../src/core/featureRequests";

describe("parseProposals", () => {
  it("returns no proposals and no errors for a quiet day", () => {
    expect(parseProposals("Nothing notable today.")).toEqual({ proposals: [], errors: [] });
  });

  it("parses a single well-formed proposal", () => {
    const output = `
Some preamble.

## Feature Request: Add retry backoff to data-refresh

Impact: medium
Effort: small
Evidence: data-refresh failed with a 429 three days running (2026-10-05..07).

The Finnhub rate limit keeps tripping. Add exponential backoff.
`;
    const { proposals, errors } = parseProposals(output);
    expect(errors).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      title: "Add retry backoff to data-refresh",
      impact: "medium",
      effort: "small",
      evidence: "data-refresh failed with a 429 three days running (2026-10-05..07).",
    });
    expect(proposals[0].body).toContain("exponential backoff");
  });

  it("parses multiple proposals, splitting correctly on each header", () => {
    const output = `
## Feature Request: First issue
Impact: low
Effort: small
Evidence: one-off warning on 2026-10-06.
Body one.

## Feature Request: Second issue
Impact: high
Effort: large
Evidence: recurring failure 2026-10-04..07.
Body two.
`;
    const { proposals, errors } = parseProposals(output);
    expect(errors).toEqual([]);
    expect(proposals.map((p) => p.title)).toEqual(["First issue", "Second issue"]);
    expect(proposals[0].body).toBe("Body one.");
    expect(proposals[1].impact).toBe("high");
  });

  it("tolerates bold field markers and field order", () => {
    const output = `
## Feature Request: Reorder fields

**Evidence:** cost anomaly on 2026-10-01.
**Effort:** medium
**Impact:** low

Body text.
`;
    const { proposals, errors } = parseProposals(output);
    expect(errors).toEqual([]);
    expect(proposals[0]).toMatchObject({ impact: "low", effort: "medium", evidence: "cost anomaly on 2026-10-01." });
  });

  it("surfaces a malformed section as a parse error instead of dropping or guessing", () => {
    const output = `
## Feature Request: Missing fields

Impact: medium

Just a vague note with no Effort or Evidence.
`;
    const { proposals, errors } = parseProposals(output);
    expect(proposals).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].title).toBe("Missing fields");
    expect(errors[0].reason).toMatch(/malformed/);
  });

  it("rejects an out-of-range or unrecognized field value", () => {
    const output = `
## Feature Request: Bad impact value

Impact: critical
Effort: small
Evidence: something.

Body.
`;
    const { proposals, errors } = parseProposals(output);
    expect(proposals).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("slugify", () => {
  it("lowercases, hyphenates, and strips punctuation", () => {
    expect(slugify("Add retry backoff to data-refresh!")).toBe("add-retry-backoff-to-data-refresh");
  });
  it("falls back to a default for a title with no alphanumerics", () => {
    expect(slugify("!!!")).toBe("proposal");
  });
});

describe("isLikelyDuplicateTitle", () => {
  it("flags a reworded title for the same issue", () => {
    expect(isLikelyDuplicateTitle("Add retry backoff to data-refresh", "Retry backoff for data refresh job")).toBe(true);
  });
  it("does not flag unrelated titles", () => {
    expect(isLikelyDuplicateTitle("Add retry backoff to data-refresh", "Investigate calendar auth token expiry")).toBe(false);
  });
});

describe("writeProposals / listProposals / readProposalFile / setProposalStatus / findProposalBySlug", () => {
  let brainRoot: string;
  const now = new Date(2026, 9, 13, 12, 0, 0); // 2026-10-13

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-featurerequests-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  const proposal = (over: Partial<Proposal> = {}): Proposal => ({
    title: "Add retry backoff to data-refresh",
    impact: "medium",
    effort: "small",
    evidence: "data-refresh failed with a 429 three days running.",
    body: "Add exponential backoff.",
    ...over,
  });

  it("writes a proposal file with frontmatter and body", () => {
    const [written] = writeProposals(brainRoot, "financial", [proposal()], { now });
    expect(written.file).toMatch(/2026-10-13-add-retry-backoff-to-data-refresh\.md$/);
    const text = fs.readFileSync(written.file!, "utf8");
    expect(text).toContain("status: proposed");
    expect(text).toContain("domain: financial");
    expect(text).toContain("impact: medium");
    expect(text).toContain("effort: small");
    expect(text).toContain("created: 2026-10-13");
    expect(text).toContain("# Add retry backoff to data-refresh");
    expect(text).toContain("Evidence: data-refresh failed with a 429 three days running.");
    expect(text).toContain("Add exponential backoff.");
  });

  it("round-trips through readProposalFile / listProposals", () => {
    writeProposals(brainRoot, "financial", [proposal()], { now });
    const [p] = listProposals(brainRoot, "financial");
    expect(p).toMatchObject({
      title: "Add retry backoff to data-refresh",
      status: "proposed",
      domain: "financial",
      impact: "medium",
      effort: "small",
      created: "2026-10-13",
    });
    expect(readProposalFile(p.file)).toMatchObject({ title: p.title });
  });

  it("returns an empty list for a domain with no feature-requests directory yet", () => {
    expect(listProposals(brainRoot, "calendar")).toEqual([]);
  });

  it("skips writing a near-duplicate of an existing proposed proposal, and reports the skip", () => {
    writeProposals(brainRoot, "financial", [proposal()], { now });
    const results = writeProposals(brainRoot, "financial", [proposal({ title: "Retry backoff for data refresh job" })], {
      now: new Date(2026, 9, 14),
    });
    expect(results[0].file).toBeNull();
    expect(results[0].skippedAsDuplicateOf).toMatch(/add-retry-backoff-to-data-refresh\.md$/);
    expect(listProposals(brainRoot, "financial")).toHaveLength(1);
  });

  it("does not treat a duplicate of a done proposal as live", () => {
    const [first] = writeProposals(brainRoot, "financial", [proposal()], { now });
    setProposalStatus(first.file!, "done");
    const results = writeProposals(brainRoot, "financial", [proposal({ title: "Retry backoff for data refresh job" })], {
      now: new Date(2026, 9, 14),
    });
    expect(results[0].file).not.toBeNull();
    expect(listProposals(brainRoot, "financial")).toHaveLength(2);
  });

  it("dedups within the same batch, not just against existing files", () => {
    const results = writeProposals(
      brainRoot,
      "financial",
      [proposal(), proposal({ title: "Retry backoff for data refresh job" })],
      { now }
    );
    expect(results[0].file).not.toBeNull();
    expect(results[1].file).toBeNull();
  });

  it("setProposalStatus rewrites status in place without moving the file", () => {
    const [written] = writeProposals(brainRoot, "financial", [proposal()], { now });
    expect(setProposalStatus(written.file!, "in-progress")).toBe(true);
    expect(readProposalFile(written.file!)?.status).toBe("in-progress");
    expect(fs.existsSync(written.file!)).toBe(true);
  });

  it("setProposalStatus returns false for a missing file", () => {
    expect(setProposalStatus(path.join(brainRoot, "financial", "feature-requests", "nope.md"), "done")).toBe(false);
  });

  it("findProposalBySlug finds by filename without extension", () => {
    const [written] = writeProposals(brainRoot, "financial", [proposal()], { now });
    const slug = path.basename(written.file!, ".md");
    expect(findProposalBySlug(brainRoot, "financial", slug)).toMatchObject({ title: proposal().title });
    expect(findProposalBySlug(brainRoot, "financial", "does-not-exist")).toBeNull();
  });
});
