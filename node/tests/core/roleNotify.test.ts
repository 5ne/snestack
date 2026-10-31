import { buildRoleEmail, parseMergeLog, renderMarkdownLite } from "../../src/core/roleNotify";
import type { ProposalFile } from "../../src/core/featureRequests";

const proposal = (over: Partial<ProposalFile> = {}): ProposalFile => ({
  file: "/x/2026-10-31-add-thing.md",
  slug: "2026-10-31-add-thing",
  title: "Add thing",
  status: "proposed",
  domain: "financial",
  impact: "medium",
  effort: "small",
  created: "2026-10-31",
  body: "",
  ...over,
});

describe("buildRoleEmail", () => {
  it("PM: stays silent when no new proposals landed", () => {
    expect(buildRoleEmail({ role: "pm", failed: false, report: "no new requests", newProposals: [] })).toBeNull();
  });

  it("PM: lists each new proposal with its approve command, adding --domain for _system", () => {
    const e = buildRoleEmail({
      role: "pm",
      failed: false,
      report: "wrote two",
      newProposals: [proposal(), proposal({ slug: "2026-10-31-sys", title: "Sys", domain: "_system" })],
    })!;
    expect(e.subject).toBe("snestack PM: 2 new feature requests");
    expect(e.text).toContain("snestack feature approve 2026-10-31-add-thing\n");
    expect(e.text).toContain("snestack feature approve 2026-10-31-sys --domain _system");
    expect(e.text).toContain("wrote two");
  });

  it("eng: always reports a finished session", () => {
    const e = buildRoleEmail({ role: "eng", failed: false, report: "picked up 1 task" })!;
    expect(e.subject).toBe("snestack eng: run finished");
    expect(e.text).toContain("picked up 1 task");
  });

  it("a failed run always emails, flagging a usage limit", () => {
    const e = buildRoleEmail({ role: "pm", failed: true, failureReason: "Claude usage limit reached", report: "" })!;
    expect(e.subject).toContain("FAILED");
    expect(e.subject).toContain("usage limit");
    expect(buildRoleEmail({ role: "eng", failed: true, report: "" })!.text).toContain("no error text captured");
  });

  it("truncates a very long report", () => {
    const e = buildRoleEmail({ role: "eng", failed: false, report: "x".repeat(10000) })!;
    expect(e.text.length).toBeLessThan(3300);
    expect(e.text).toContain("truncated");
  });
});

describe("HTML emails", () => {
  it("PM email separates proposals needing approval from auto-approved ones, with chips and commands", () => {
    const e = buildRoleEmail({
      role: "pm",
      failed: false,
      report: "## Notes\n- one **bold** thing\n- `code` here",
      date: "2026-10-31",
      newProposals: [proposal({ title: "Needs me" }), proposal({ slug: "auto", title: "Robot ok", autoApproved: true, status: "approved" })],
    })!;
    expect(e.html).toContain("<!DOCTYPE html>");
    expect(e.html).toContain("New feature requests");
    expect(e.html).toContain("Needs your approval (1)");
    expect(e.html).toContain("Auto-approved (1)");
    expect(e.html).toContain("snestack feature approve 2026-10-31-add-thing");
    expect(e.html).toContain("impact: medium");
    expect(e.html).toContain("<strong");
    expect(e.html).toContain("Saturday, October 31, 2026");
  });

  it("escapes HTML coming from proposal titles and reports", () => {
    const e = buildRoleEmail({
      role: "pm",
      failed: false,
      report: "<script>alert(1)</script>",
      newProposals: [proposal({ title: "<img src=x onerror=1>" })],
    })!;
    expect(e.html).not.toContain("<script>");
    expect(e.html).not.toContain("<img src=x");
    expect(e.html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("eng email splits merged work from work left for review", () => {
    const log = [
      "- good: MERGED into main (tests green, paths allowlisted); marked done.",
      "- bad: NOT auto-merged (needs owner review of eng/bad):",
      "    not auto-mergeable path: node/src/core/executor.ts",
    ].join("\n");
    const e = buildRoleEmail({ role: "eng", failed: false, report: "did things", mergeLog: log })!;
    expect(e.subject).toBe("snestack eng: 1 merged, 1 need review");
    expect(e.html).toContain("Merged to main (1)");
    expect(e.html).toContain("Left for your review (1)");
    expect(e.html).toContain("executor.ts");
    expect(e.text).toContain("Auto-merge:");
  });

  it("failure email is a red card with a usage-limit hint", () => {
    const e = buildRoleEmail({ role: "eng", failed: true, failureReason: "Claude usage limit reached", report: "" })!;
    expect(e.html).toContain("#dc2626");
    expect(e.html).toContain("usage limit");
  });

  it("parseMergeLog and renderMarkdownLite behave", () => {
    expect(parseMergeLog("- a: MERGED x\n- b: NOT auto-merged y\n    detail")).toEqual([
      { id: "a", merged: true, detail: ["MERGED x"] },
      { id: "b", merged: false, detail: ["NOT auto-merged y", "detail"] },
    ]);
    const html = renderMarkdownLite("# T\n1. a\n2. b\n\ntext");
    expect(html).toContain("<ol");
    expect(html).toContain("<p");
  });
});

