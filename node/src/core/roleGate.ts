import * as fs from "fs";
import * as path from "path";
import type { Role } from "./roleNotify";

/**
 * Deterministic gate for the PM role (the same idea as a skill's `gate:`): a quiet stretch with no new
 * automation run records costs no model call. The PM session runs when it has never run, when any
 * run.json has been written since the last successful run, or when the last run is older than `maxAgeDays`
 * (so triage of existing proposals can't starve). Domain-agnostic: it looks at <brain>/<domain>/{signals,runs}
 * for every domain folder, ignoring the PM/eng roles' own run records.
 */

const MARKER = ".last-run.json";
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_AGE_DAYS = 7;

function markerPath(brainRoot: string, role: Role): string {
  return path.join(brainRoot, "_system", "runs", role, MARKER);
}

export function readLastRoleRun(brainRoot: string, role: Role): Date | null {
  try {
    const t = Date.parse(JSON.parse(fs.readFileSync(markerPath(brainRoot, role), "utf8")).lastRunAt);
    return isFinite(t) ? new Date(t) : null;
  } catch {
    return null;
  }
}

export function recordRoleRun(brainRoot: string, role: Role, now: Date): void {
  const file = markerPath(brainRoot, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ lastRunAt: now.toISOString() }) + "\n");
}

/** Count of run.json files newer than `since` under <brain>/<domain>/{signals,runs}, skipping _system/runs/pm|eng. */
export function countNewRunRecords(brainRoot: string, since: Date | null, maxDepth = 5): number {
  if (!fs.existsSync(brainRoot)) return 0;
  const sinceMs = since ? since.getTime() : 0;
  let count = 0;
  const walk = (dir: string, depth: number, skip: boolean): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !(skip && (e.name === "pm" || e.name === "eng"))) walk(full, depth + 1, skip);
      } else if (e.name === "run.json") {
        try {
          if (fs.statSync(full).mtimeMs > sinceMs) count++;
        } catch {
          // ignore
        }
      }
    }
  };
  for (const d of fs.readdirSync(brainRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    for (const sub of ["signals", "runs"]) walk(path.join(brainRoot, d.name, sub), 0, d.name === "_system");
  }
  return count;
}

export interface RoleGateDecision {
  run: boolean;
  reasons: string[];
}

export function decideRoleGate(
  brainRoot: string,
  role: Role,
  opts: { now?: Date; force?: boolean; maxAgeDays?: number } = {}
): RoleGateDecision {
  const now = opts.now ?? new Date();
  if (opts.force) return { run: true, reasons: ["--force"] };
  const last = readLastRoleRun(brainRoot, role);
  if (!last) return { run: true, reasons: ["no previous run recorded"] };
  const maxAge = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const ageDays = (now.getTime() - last.getTime()) / DAY_MS;
  if (ageDays >= maxAge) return { run: true, reasons: [`last run was ${ageDays.toFixed(1)} days ago (max ${maxAge})`] };
  const fresh = countNewRunRecords(brainRoot, last);
  if (fresh > 0) return { run: true, reasons: [`${fresh} new run record(s) since ${last.toISOString()}`] };
  return { run: false, reasons: [`no new run records since ${last.toISOString()} and last run was ${ageDays.toFixed(1)} days ago`] };
}
