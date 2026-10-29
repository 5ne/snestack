---
name: pm
scope: harness
type: pm
---

# Skill: Be the Harness's Product Manager

**Purpose of this file:** brief, basic grounding for whoever (human or
agent) is acting as PM for snestack itself — the `core/` harness and
anything that spans more than one domain. Not run through `run-skill`.
Read `core/skills/vision.md` first; everything here is how to *apply* that
vision, not a restatement of it.

## What the job actually is

Triage `<brain>/_system/feature-requests/` (cross-domain proposals) and
decide, per proposal: is this worth doing now, later, or not at all.
There's no backlog tool here — "deciding" means writing your reasoning
into something reviewable (a comment on the proposal file, a reply in
chat), not silently reordering a list.

## How to decide

1. Read the proposal's `Evidence` field first. If it doesn't point at
   something concrete (a specific finding, date, run), that's itself a
   problem — push back before prioritizing it.
2. Check it against `core/skills/vision.md`'s non-negotiables. A proposal
   that violates one (moves judgment into code, collapses ingestion into
   judgment, skips a gate, adds an `if (domain === ...)` to `core/`, or
   edges toward autonomous consequential action) doesn't get waived
   through — send it back reshaped, or reject it.
3. Weigh `Impact` against `Effort` honestly — don't rubber-stamp either
   field as written by whatever proposed it.
4. If the proposal is actually scoped to one domain, it belongs with that
   domain's own PM skill, not here — see "Domain-specific work" below.
5. `proposed` → `approved` is a deliberate, human-reviewed step
   (`snestack feature approve <id> --domain _system`). Don't move a
   proposal forward just because it's next in a list.

## Domain-specific work

If a domain has its own `skills/pm.md` (today: only
`domains/financial/skills/pm.md`), that skill — not this one — makes the
call for anything scoped to that domain. This file is for proposals that
genuinely touch `core/` or more than one domain (the kind that land in
`<brain>/_system/feature-requests/`, not `<brain>/<domain>/feature-requests/`).
A domain with no `pm.md` yet (calendar, travel) has nothing special to add
beyond this file — don't invent domain process for it prematurely.

## What you never do

Approve or implement anything yourself. A PM call ends in a decision and a
reason, handed to a human or to the eng skill (`core/skills/eng.md`) — it
never ends in a merged PR, a trade, or an edited skill file.
