import type { ProposalFile } from "./featureRequests";

/**
 * The owner-approved autonomy policy for the PM -> eng loop (decided 2026-10-31): low-risk proposals are
 * approved, implemented and merged to main without a human step; everything else still waits for the owner.
 * The policy lives here, in code, not in the agents' prompts, so a model cannot talk its way past it.
 *
 * Three independent checks, all deterministic:
 *  1. eligibleForAutoApprove: PM-sourced, small effort, low/medium impact, and the proposal text does not touch
 *     anything on the risk list (judgment skills, the executor, scheduling, secrets, trading, the database ...).
 *  2. changedPathViolations: at merge time every changed file must be on an allowlist (tests, docs, run
 *     observability). The allowlist is closed: a path nobody listed is not allowed.
 *  3. diffLooksSecret: nothing that looks like a credential in the diff.
 * Plus the script runs typecheck + the full test suite on the branch before merging.
 */

export const MAX_AUTO_APPROVALS_PER_RUN = 2;

const RISK_WORDS =
  /skills\/|\bskill\b|executor|\bcron\b|crontab|scripts\/|\.env\b|secret|token|api[ -]?key|password|credential|verdict|\b(buy|sell|trim|trade|trading|position|portfolio)\b|\bgate\b|prompt|brain|delete|migrat|database|supabase|postgres|auth|email|notify|claude-cli|agy-cli|\bagy\b|launchd|permission/i;

export interface AutoApproveDecision {
  ok: boolean;
  reasons: string[];
}

export function eligibleForAutoApprove(p: ProposalFile): AutoApproveDecision {
  const reasons: string[] = [];
  if (p.status !== "proposed") reasons.push(`status is ${p.status}`);
  if (p.source !== "pm") reasons.push(`source is ${p.source ?? "unknown"}, not pm`);
  if (p.effort !== "small") reasons.push(`effort is ${p.effort ?? "?"}, not small`);
  if (p.impact !== "low" && p.impact !== "medium") reasons.push(`impact is ${p.impact ?? "?"}, not low/medium`);
  const hit = RISK_WORDS.exec(`${p.title}\n${p.body}`);
  if (hit) reasons.push(`mentions "${hit[0]}", which is on the risk list`);
  return { ok: reasons.length === 0, reasons };
}

/** Files an auto-merged change may touch. Closed list: anything not matched is a violation. */
const ALLOWED_PATHS: RegExp[] = [
  /^node\/tests\//,
  /^node\/README\.md$/,
  /^README\.md$/,
  /^CONTRIBUTING\.md$/,
  /^node\/src\/core\/(runCheck|runLog|runStats|runReport)\.ts$/,
  /^node\/src\/domains\/[^/]+\/runExpectations\.ts$/,
];

export function changedPathViolations(paths: string[]): string[] {
  return paths.map((p) => p.trim()).filter(Boolean).filter((p) => !ALLOWED_PATHS.some((re) => re.test(p)));
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{12,}/i,
  /postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@/,
];

/** True when the added lines of a unified diff contain something that looks like a credential. */
export function diffLooksSecret(diff: string): boolean {
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  return SECRET_PATTERNS.some((re) => re.test(added));
}
