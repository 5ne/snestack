import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildReflectEmail, type DomainReflectResult } from "../../src/core/reflectNotify";
import { writeProposals } from "../../src/core/featureRequests";

describe("buildReflectEmail", () => {
  let brainRoot: string;
  const now = new Date("2026-10-13T00:00:00Z");

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-reflectnotify-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  const quietResult = (domain: string, reason = "no trigger: quiet"): DomainReflectResult => ({
    domain,
    ran: false,
    reason,
    written: [],
    skippedDuplicates: [],
    parseErrors: [],
  });

  it("returns null when nothing new was written and there were no parse errors", () => {
    expect(buildReflectEmail([quietResult("financial"), quietResult("calendar")])).toBeNull();
  });

  it("builds a subject and body listing each new proposal with its approve command", () => {
    const [written] = writeProposals(
      brainRoot,
      "financial",
      [
        {
          title: "Add retry backoff to data-refresh",
          impact: "medium",
          effort: "small",
          evidence: "429s three days running.",
          body: "Add backoff.",
        },
      ],
      { now }
    );
    const slug = path.basename(written.file!, ".md");

    const result: DomainReflectResult = {
      domain: "financial",
      ran: true,
      reason: "last run was 8.0 days ago",
      written: [written.file!],
      skippedDuplicates: [],
      parseErrors: [],
    };

    const email = buildReflectEmail([result, quietResult("calendar")]);
    expect(email).not.toBeNull();
    expect(email!.subject).toBe("snestack: 1 new improvement proposal");
    expect(email!.text).toContain("[financial] Add retry backoff to data-refresh");
    expect(email!.text).toContain("impact=medium, effort=small");
    expect(email!.text).toContain(`snestack feature approve ${slug}`);
  });

  it("pluralizes the subject for more than one new proposal, across domains", () => {
    const [a] = writeProposals(
      brainRoot,
      "financial",
      [{ title: "Issue A", impact: "low", effort: "small", evidence: "e1", body: "b1" }],
      { now }
    );
    const [b] = writeProposals(
      brainRoot,
      "calendar",
      [{ title: "Issue B", impact: "high", effort: "large", evidence: "e2", body: "b2" }],
      { now }
    );
    const results: DomainReflectResult[] = [
      { domain: "financial", ran: true, reason: "r", written: [a.file!], skippedDuplicates: [], parseErrors: [] },
      { domain: "calendar", ran: true, reason: "r", written: [b.file!], skippedDuplicates: [], parseErrors: [] },
    ];
    const email = buildReflectEmail(results);
    expect(email!.subject).toBe("snestack: 2 new improvement proposals");
    expect(email!.text).toContain("[financial] Issue A");
    expect(email!.text).toContain("[calendar] Issue B");
  });

  it("surfaces parse errors even when nothing was written", () => {
    const result: DomainReflectResult = {
      domain: "financial",
      ran: true,
      reason: "last run was 8.0 days ago",
      written: [],
      skippedDuplicates: [],
      parseErrors: ['"Some title": missing or malformed Impact/Effort/Evidence field block'],
    };
    const email = buildReflectEmail([result]);
    expect(email).not.toBeNull();
    expect(email!.subject).toContain("parse errors");
    expect(email!.text).toContain("[financial]");
    expect(email!.text).toContain("missing or malformed");
  });
});
