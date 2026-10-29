---
name: eng
scope: harness
type: eng
---

# Skill: Be the Harness's Software Engineer

**Purpose of this file:** brief, basic grounding for whoever (human or
agent) is acting as the engineer implementing a `core/`-level or
cross-domain change — usually an approved proposal from
`<brain>/_system/feature-requests/`, triaged by `core/skills/pm.md`. Not
run through `run-skill`. Read `core/skills/vision.md` first, especially
"How the harness is actually architected" — that section *is* the spec for
how `core/` is put together; don't re-derive it from scratch.

## What the job actually is

Turn an approved proposal into a normal PR a human reviews. Nothing here
authorizes merging or deploying yourself — that's still a human step, same
as any other contribution (see `CONTRIBUTING.md`).

## How to work

0. Only pick up a proposal whose status is `approved`. When you start,
   run `snestack feature start <id>` (moves it to `in-progress`; it refuses
   anything not `approved`, so a repeat run won't double-claim one). Leave
   `done` to a human after the PR merges.
1. Confirm the change actually belongs in `core/` before touching it: can
   every domain ignore this and keep working? If not, it's domain work —
   see "Domain-specific work" below.
2. Follow the existing module boundaries (`skillLoader`, `domainRegistry`,
   `runSkill`, `executor`, `gate`, `verdict`, `runLog`/`runCheck`,
   `reflect`/`featureRequests`, `safeWrite`) — extend the one that owns the
   concern, don't blur two together.
3. Keep `core/` ignorant of any specific domain. If you're tempted to
   write `if (domain === "financial")` inside `core/`, stop — that belongs
   in that domain's `contextTools.ts` instead.
4. Write tests the way `CONTRIBUTING.md` describes (mock external APIs,
   use the shared fixtures under `node/tests/core/`).
5. Run `npm run typecheck && npm run lint && npm test` before opening the
   PR.
6. If the change touches the unregistered `node/scripts/*.sh` automation
   gap (see vision.md's "Scheduled automation" section), say explicitly in
   the PR whether this change starts registering it or is deliberately
   staying inside the existing flat/copy-pasted convention for now.

## Domain-specific work

If a domain has its own `skills/eng.md` (today: only
`domains/financial/skills/eng.md`), implementation work scoped entirely to
that domain follows that skill's conventions instead of this one — adding
a skill, a context tool, an agent, or a cron script inside one domain is
domain work even though the harness provides the scaffolding it runs on.
This file is for changes to `core/` itself, or that touch more than one
domain's `contextTools.ts`.

## What you never do

Merge your own PR, deploy anything, or treat "the code compiles" as
authorization to skip human review. Nothing built here executes a trade,
sends an irreversible message, or edits a skill/brain file autonomously —
see `core/skills/vision.md` principle 5.
