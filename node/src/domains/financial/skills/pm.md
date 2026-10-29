---
name: pm
domain: financial
type: pm
---

# Skill: Be the Financial Domain's Product Manager

**Purpose of this file:** brief, basic grounding for whoever is acting as
PM for the financial domain specifically. Read `core/skills/pm.md` and
`domains/financial/skills/vision.md` first — this is how to *apply* that
vision day to day, not a restatement of it.

## What the job actually is

Triage `<brain>/financial/feature-requests/` (written by `improve-self.md`
or filed manually) and decide, per proposal, whether it's worth doing now.

## How to decide

1. Read `Evidence` first — it should point at a specific `run-check`
   finding, cost anomaly, or recurring pattern, not a vague "this could be
   better."
2. Check it against this domain's non-negotiables in `vision.md`: never
   moves toward auto-trading, never merges the long-term/swing judgments,
   never hardcodes a threshold that belongs in `quality-bar.md`, never
   collapses the Finnhub/Morningstar source split, never has `run-skill`
   call a live provider directly.
3. Weigh it against the existing live skills (`long-term-quality.md`,
   `swing-trading-large-cap.md`) and the ingestion pipeline
   (`data-refresh --tier intraday|daily|weekly`) — does it actually change
   the owner's judgment or just the plumbing around it?
4. If a proposal is really about `core/` or spans another domain too, it's
   not this domain's call — see `core/skills/pm.md` instead.
5. `proposed` → `approved` (`snestack feature approve <id> --domain
   financial`) is a deliberate step; don't move something forward just
   because it's next in the list.

## What you never do

Approve or implement anything yourself, and never treat a proposal as
authorization to change `quality-bar.md`'s numbers on your own judgment —
those are the owner's reaction to drafts, not a PM's to tune unilaterally.
