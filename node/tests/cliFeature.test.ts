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

describe("CLI: role-gate / role-notify (no model calls, no email)", () => {
  let brainRoot: string;
  const run = (args: string) =>
    execSync(`npx ts-node --project tsconfig.json ${CLI} ${args}`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, SNESTACK_BRAIN_ROOT: brainRoot },
    });
  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-cli-role-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  it("role-gate runs the first time, skips (exit 4) when quiet after a recorded run, and --force overrides", () => {
    expect(run("role-gate --role pm")).toMatch(/^RUN/);
    run("role-gate --role pm --record");
    let code = 0;
    try {
      run("role-gate --role pm");
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(4);
    expect(run("role-gate --role pm --force")).toMatch(/^RUN: --force/);
  });

  it("role-notify --dry-run lists only proposals that are new since the --before snapshot", () => {
    const old = writeProposalFixture(brainRoot, "financial", "Old thing");
    const fresh = writeProposalFixture(brainRoot, "financial", "Brand new thing");
    const before = path.join(brainRoot, "before.txt");
    fs.writeFileSync(before, `${path.basename(old, ".md")}  [proposed]  financial\n`);
    const report = path.join(brainRoot, "report.md");
    fs.writeFileSync(report, "wrote one request");
    const out = run(`role-notify --role pm --report ${report} --before ${before} --dry-run`);
    expect(out).toContain("Brand new thing");
    expect(out).toContain(`feature approve ${path.basename(fresh, ".md")}`);
    expect(out).not.toContain("Old thing");
  });

  it("role-notify sends nothing for a quiet PM run", () => {
    const old = writeProposalFixture(brainRoot, "financial", "Old thing");
    const before = path.join(brainRoot, "before.txt");
    fs.writeFileSync(before, `${path.basename(old, ".md")}  [proposed]\n`);
    expect(run(`role-notify --role pm --before ${before} --dry-run`)).toMatch(/nothing new/i);
  });
});

describe("CLI: feature auto-approve / merge-check (no model calls)", () => {
  let brainRoot: string;
  const run = (args: string) =>
    execSync(`npx ts-node --project tsconfig.json ${CLI} ${args}`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, SNESTACK_BRAIN_ROOT: brainRoot },
    });
  const write = (name: string, fields: string, body: string) => {
    const dir = path.join(brainRoot, "financial", "feature-requests");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `2026-10-31-${name}.md`);
    fs.writeFileSync(file, `---\nstatus: proposed\ndomain: financial\n${fields}created: 2026-10-31\nsource: pm\n---\n# ${name}\n\n${body}\n`);
    return file;
  };
  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-cli-auto-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  it("approves only the low-risk proposal and tags it auto-approved", () => {
    const safe = write("safe-one", "impact: low\neffort: small\n", "Add a run-check finding and test.");
    const risky = write("risky-one", "impact: low\neffort: small\n", "Edit skills/long-term-quality.md.");
    const big = write("big-one", "impact: low\neffort: large\n", "Add a test.");
    const dry = run("feature auto-approve --dry-run");
    expect(dry).toContain("would auto-approve: 2026-10-31-safe-one");
    expect(fs.readFileSync(safe, "utf8")).toContain("status: proposed");
    const out = run("feature auto-approve");
    expect(out).toContain("auto-approved: 2026-10-31-safe-one");
    expect(out).toContain("needs owner: 2026-10-31-risky-one");
    expect(out).toContain("needs owner: 2026-10-31-big-one");
    expect(fs.readFileSync(safe, "utf8")).toMatch(/status: approved/);
    expect(fs.readFileSync(risky, "utf8")).toMatch(/status: proposed/);
    expect(fs.readFileSync(big, "utf8")).toMatch(/status: proposed/);
    expect(run("feature list --status approved")).toContain("(auto-approved)");
  });

  it("caps auto-approvals per run at 2", () => {
    ["a", "b", "c"].forEach((n) => write(`cap-${n}`, "impact: low\neffort: small\n", "Add a test."));
    const out = run("feature auto-approve");
    expect((out.match(/^auto-approved:/gm) ?? []).length).toBe(2);
    expect(out).toContain("per-run cap");
  });

  it("merge-check passes allowlisted paths and fails others or a leaked secret", () => {
    const ok = path.join(brainRoot, "ok.txt");
    fs.writeFileSync(ok, "node/tests/core/x.test.ts\nnode/README.md\n");
    expect(run(`feature merge-check --paths ${ok}`)).toContain("auto-mergeable");
    const bad = path.join(brainRoot, "bad.txt");
    fs.writeFileSync(bad, "node/tests/x.test.ts\nnode/src/core/executor.ts\n");
    expect(() => run(`feature merge-check --paths ${bad}`)).toThrow();
    const diff = path.join(brainRoot, "d.diff");
    fs.writeFileSync(diff, "+TOKEN=sk-ant-oat01-abcdefghijklmnopqrstuv\n");
    expect(() => run(`feature merge-check --paths ${ok} --diff ${diff}`)).toThrow();
  });
});
