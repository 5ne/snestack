import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Writes a proposal file in the shape the PM role produces (see scripts/prompts/pm-daily.md). */
function writeProposalFixture(brainRoot: string, domain: string, title: string, created = "2026-10-13"): string {
  const dir = path.join(brainRoot, domain, "feature-requests");
  fs.mkdirSync(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const file = path.join(dir, `${created}-${slug}.md`);
  fs.writeFileSync(
    file,
    `---\nstatus: proposed\ndomain: ${domain}\nimpact: medium\neffort: small\ncreated: ${created}\nsource: pm\n---\n# ${title}\n\nEvidence: 429s three days running.\n`
  );
  return file;
}

const CLI = path.resolve(__dirname, "../src/cli.ts");

describe("CLI: feature (no model calls — safe to smoke-test)", () => {
  let brainRoot: string;

  const run = (args: string) =>
    execSync(`npx ts-node --project tsconfig.json ${CLI} ${args}`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, SNESTACK_BRAIN_ROOT: brainRoot },
    });

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-cli-feature-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  it("feature list reports no proposals for an empty brain root", () => {
    const out = run("feature list");
    expect(out).toMatch(/No feature-request proposals/i);
  });

  it("feature list prints a written proposal with its slug and status", () => {
    const slug = path.basename(writeProposalFixture(brainRoot, "financial", "Add retry backoff to data-refresh"), ".md");

    const out = run("feature list");
    expect(out).toContain(slug);
    expect(out).toContain("[proposed]");
    expect(out).toContain("financial");

    const scoped = run("feature list --domain financial --status proposed");
    expect(scoped).toContain(slug);
    const empty = run("feature list --domain calendar");
    expect(empty).toMatch(/No feature-request proposals/i);
  });

  it("feature approve moves proposed -> approved, start moves approved -> in-progress, and done moves it on to done", () => {
    const slug = path.basename(writeProposalFixture(brainRoot, "financial", "Add retry backoff to data-refresh"), ".md");

    const approveOut = run(`feature approve ${slug}`);
    expect(approveOut).toContain("-> approved");
    expect(run("feature list")).toContain("[approved]");

    const startOut = run(`feature start ${slug}`);
    expect(startOut).toContain("-> in-progress");
    expect(run("feature list")).toContain("[in-progress]");
    // start only works from approved
    expect(() => run(`feature start ${slug}`)).toThrow(/not approved/);

    const doneOut = run(`feature done ${slug}`);
    expect(doneOut).toContain("-> done");
    expect(run("feature list")).toContain("[done]");
  });

  it("feature approve fails loudly for an unknown id", () => {
    expect(() => run("feature approve does-not-exist")).toThrow(/no proposal found/);
  });
});
