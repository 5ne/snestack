import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { changedPathViolations, diffLooksSecret, eligibleForAutoApprove } from "../../src/core/autoMerge";
import { readProposalFile, setProposalField, setProposalStatus, type ProposalFile } from "../../src/core/featureRequests";

const proposal = (over: Partial<ProposalFile> = {}): ProposalFile => ({
  file: "/x/p.md",
  slug: "p",
  title: "Add a run-check finding for stale cache",
  status: "proposed",
  domain: "financial",
  impact: "low",
  effort: "small",
  created: "2026-10-31",
  source: "pm",
  body: "Evidence: run-check misses it. Add a finding and a test.",
  ...over,
});

describe("eligibleForAutoApprove", () => {
  it("accepts a small, low-impact, PM-written request with no risky terms", () => {
    expect(eligibleForAutoApprove(proposal())).toEqual({ ok: true, reasons: [] });
    expect(eligibleForAutoApprove(proposal({ impact: "medium" })).ok).toBe(true);
  });

  it("rejects large effort, high impact, owner/manual sources and non-proposed status", () => {
    expect(eligibleForAutoApprove(proposal({ effort: "medium" })).ok).toBe(false);
    expect(eligibleForAutoApprove(proposal({ impact: "high" })).ok).toBe(false);
    expect(eligibleForAutoApprove(proposal({ source: "owner" })).ok).toBe(false);
    expect(eligibleForAutoApprove(proposal({ status: "approved" })).ok).toBe(false);
  });

  it.each([
    "Edit skills/long-term-quality.md to change the verdict",
    "Change the executor fallback",
    "Add a crontab entry",
    "Rotate the token in .env",
    "Make the BUY threshold lower",
    "Adjust the swing gate",
    "Migrate the database",
    "Send an email when it fails",
  ])("rejects a proposal mentioning risky territory: %s", (text) => {
    expect(eligibleForAutoApprove(proposal({ body: text })).ok).toBe(false);
  });
});

describe("changedPathViolations", () => {
  it("allows tests, docs and run observability only", () => {
    expect(
      changedPathViolations([
        "node/tests/core/runCheck.test.ts",
        "node/README.md",
        "node/src/core/runCheck.ts",
        "node/src/core/runStats.ts",
        "node/src/domains/financial/runExpectations.ts",
      ])
    ).toEqual([]);
  });

  it("flags everything else, including skills, the executor, scripts, config and package files", () => {
    const bad = [
      "node/src/domains/financial/skills/long-term-quality.md",
      "node/src/core/executor.ts",
      "node/scripts/daily-analysis.sh",
      "node/src/core/config.ts",
      "node/package.json",
      "node/.env",
      "node/src/cli.ts",
      "CLAUDE.md",
      "node/src/core/skills/eng.md",
    ];
    expect(changedPathViolations([...bad, "node/tests/ok.test.ts"])).toEqual(bad);
  });
});

describe("diffLooksSecret", () => {
  it("flags added credentials but ignores removed lines and ordinary code", () => {
    expect(diffLooksSecret("+CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnop")).toBe(true);
    expect(diffLooksSecret('+const password = "hunter2hunter2hunter2"')).toBe(true);
    expect(diffLooksSecret("+postgres://user:pass@host:5432/db")).toBe(true);
    expect(diffLooksSecret("-sk-ant-oat01-abcdefghijklmnop\n+const x = 1;")).toBe(false);
    expect(diffLooksSecret("+const token = getToken();")).toBe(false);
  });
});

describe("setProposalField", () => {
  it("adds and then updates a frontmatter field in place", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-field-"));
    const file = path.join(dir, "p.md");
    fs.writeFileSync(file, "---\nstatus: proposed\nsource: pm\n---\n# T\n\nbody\n");
    expect(setProposalField(file, "auto_approved", "true")).toBe(true);
    setProposalStatus(file, "approved");
    const p = readProposalFile(file)!;
    expect(p.autoApproved).toBe(true);
    expect(p.status).toBe("approved");
    expect(p.title).toBe("T");
    expect(setProposalField(file, "auto_approved", "false")).toBe(true);
    expect(readProposalFile(file)!.autoApproved).toBe(false);
    expect(fs.readFileSync(file, "utf8").match(/auto_approved/g)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
