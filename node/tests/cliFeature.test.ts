import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeProposals } from "../src/core/featureRequests";

const CLI = path.resolve(__dirname, "../src/cli.ts");

describe("CLI: feature (no model calls — safe to smoke-test)", () => {
  let brainRoot: string;

  const run = (args: string) =>
    execSync(`NODE_OPTIONS=--experimental-sqlite npx ts-node --project tsconfig.json ${CLI} ${args}`, {
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
      { now: new Date("2026-10-13T00:00:00Z") }
    );
    const slug = path.basename(written.file!, ".md");

    const out = run("feature list");
    expect(out).toContain(slug);
    expect(out).toContain("[proposed]");
    expect(out).toContain("financial");

    const scoped = run("feature list --domain financial --status proposed");
    expect(scoped).toContain(slug);
    const empty = run("feature list --domain calendar");
    expect(empty).toMatch(/No feature-request proposals/i);
  });

  it("feature approve moves proposed -> in-progress, and done moves it on to done", () => {
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
      { now: new Date("2026-10-13T00:00:00Z") }
    );
    const slug = path.basename(written.file!, ".md");

    const approveOut = run(`feature approve ${slug}`);
    expect(approveOut).toContain("-> in-progress");
    expect(run("feature list")).toContain("[in-progress]");

    const doneOut = run(`feature done ${slug}`);
    expect(doneOut).toContain("-> done");
    expect(run("feature list")).toContain("[done]");
  });

  it("feature approve fails loudly for an unknown id", () => {
    expect(() => run("feature approve does-not-exist")).toThrow(/no proposal found/);
  });
});

describe("CLI: reflect --force (no model call for a domain with no improve-self skill yet)", () => {
  let brainRoot: string;

  const run = (args: string) =>
    execSync(`NODE_OPTIONS=--experimental-sqlite npx ts-node --project tsconfig.json ${CLI} ${args}`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        SNESTACK_BRAIN_ROOT: brainRoot,
        SNESTACK_FINNHUB_API_KEY: "fake-finnhub-key-0123456789",
        SNESTACK_CLAUDE_API_KEY: "sk-fake-claude-key-0123456789",
        SNESTACK_GMAIL_ADDRESS: "test@example.com",
        SNESTACK_NOTIFICATION_EMAIL: "test@example.com",
      },
    });

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-cli-reflect-force-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  it("--force still skips a domain with no improve-self skill (the no-skill check runs before the gate/force check)", () => {
    const out = run("reflect --domain calendar --force");
    expect(out).toMatch(/skipped \(no improve-self skill for this domain yet\)/);
  });

  it("--force reports as forced in --json output's reason for a domain with no skill (still skipped, not run)", () => {
    const out = run("reflect --domain travel --force --json");
    const results = JSON.parse(out);
    expect(results).toEqual([
      { domain: "travel", ran: false, reason: "no improve-self skill for this domain yet", written: [], skippedDuplicates: [], parseErrors: [] },
    ]);
  });
});

describe("CLI: reflect-notify --dry-run (no email send — safe to smoke-test)", () => {
  let brainRoot: string;

  const run = (args: string) =>
    execSync(`NODE_OPTIONS=--experimental-sqlite npx ts-node --project tsconfig.json ${CLI} ${args}`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, SNESTACK_BRAIN_ROOT: brainRoot },
    });

  beforeEach(() => {
    brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-cli-reflectnotify-"));
  });
  afterEach(() => fs.rmSync(brainRoot, { recursive: true, force: true }));

  it("prints nothing-to-send for an all-quiet reflect result", () => {
    const file = path.join(brainRoot, "reflect.json");
    fs.writeFileSync(file, JSON.stringify([{ domain: "financial", ran: false, reason: "no trigger", written: [], skippedDuplicates: [], parseErrors: [] }]));
    expect(run(`reflect-notify --file ${file} --dry-run`)).toMatch(/nothing to send/i);
  });

  it("prints the subject and body for a result with a new proposal", () => {
    const [written] = writeProposals(
      brainRoot,
      "financial",
      [{ title: "Add retry backoff to data-refresh", impact: "medium", effort: "small", evidence: "429s.", body: "Add backoff." }],
      { now: new Date("2026-10-13T00:00:00Z") }
    );
    const slug = path.basename(written.file!, ".md");
    const file = path.join(brainRoot, "reflect.json");
    fs.writeFileSync(
      file,
      JSON.stringify([{ domain: "financial", ran: true, reason: "x", written: [written.file], skippedDuplicates: [], parseErrors: [] }])
    );

    const out = run(`reflect-notify --file ${file} --dry-run`);
    expect(out).toContain("1 new improvement proposal");
    expect(out).toContain("Add retry backoff to data-refresh");
    expect(out).toContain(`feature approve ${slug}`);
  });
});
