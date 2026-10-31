import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { countNewRunRecords, decideRoleGate, readLastRoleRun, recordRoleRun } from "../../src/core/roleGate";

describe("PM role gate", () => {
  let brain: string;
  const now = new Date("2026-10-31T12:00:00Z");
  const writeRun = (rel: string, mtime: Date) => {
    const f = path.join(brain, rel, "run.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "{}");
    fs.utimesSync(f, mtime, mtime);
  };
  beforeEach(() => {
    brain = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-rolegate-"));
  });
  afterEach(() => fs.rmSync(brain, { recursive: true, force: true }));

  it("runs when it has never run", () => {
    expect(decideRoleGate(brain, "pm", { now })).toMatchObject({ run: true });
  });

  it("skips when nothing new has appeared and the last run is recent", () => {
    recordRoleRun(brain, "pm", new Date("2026-10-30T12:00:00Z"));
    writeRun("financial/signals/2026-10-29", new Date("2026-10-29T10:00:00Z"));
    expect(decideRoleGate(brain, "pm", { now }).run).toBe(false);
  });

  it("runs when a run.json is newer than the last run (any domain, signals or runs)", () => {
    recordRoleRun(brain, "pm", new Date("2026-10-30T12:00:00Z"));
    writeRun("travel/runs/nightly/2026-10-31/010000", new Date("2026-10-31T01:00:00Z"));
    const d = decideRoleGate(brain, "pm", { now });
    expect(d.run).toBe(true);
    expect(d.reasons[0]).toContain("1 new run record");
  });

  it("ignores the PM and eng roles' own run records", () => {
    const last = new Date("2026-10-30T12:00:00Z");
    recordRoleRun(brain, "pm", last);
    writeRun("_system/runs/pm/2026-10-31", new Date("2026-10-31T01:00:00Z"));
    writeRun("_system/runs/eng/2026-10-31", new Date("2026-10-31T02:00:00Z"));
    writeRun("_system/runs/other/2026-10-31", new Date("2026-10-31T03:00:00Z"));
    expect(countNewRunRecords(brain, last)).toBe(1);
  });

  it("runs after the max age even if quiet, and --force always runs", () => {
    recordRoleRun(brain, "pm", new Date("2026-10-20T12:00:00Z"));
    expect(decideRoleGate(brain, "pm", { now }).run).toBe(true);
    recordRoleRun(brain, "pm", new Date("2026-10-30T12:00:00Z"));
    expect(decideRoleGate(brain, "pm", { now, force: true }).reasons).toEqual(["--force"]);
  });

  it("round-trips the marker", () => {
    const t = new Date("2026-10-30T12:00:00Z");
    recordRoleRun(brain, "pm", t);
    expect(readLastRoleRun(brain, "pm")?.toISOString()).toBe(t.toISOString());
    expect(readLastRoleRun(brain, "eng")).toBeNull();
  });
});
