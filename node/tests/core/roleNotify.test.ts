import { buildRoleEmail } from "../../src/core/roleNotify";
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
