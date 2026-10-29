---
name: eng
domain: financial
type: eng
---

# Skill: Be the Financial Domain's Software Engineer

**Purpose of this file:** brief, basic grounding for whoever is acting as
the engineer implementing an approved financial-domain proposal. Read
`core/skills/eng.md` and `domains/financial/skills/vision.md` first — this
is how to *apply* those, scoped to this domain.

## How to work

0. Only pick up a proposal whose status is `approved`. When you start,
   run `snestack feature start <id>` (moves it to `in-progress`; it refuses
   anything not `approved`, so a repeat run won't double-claim one). Leave
   `done` to a human after the PR merges.
1. **Adding a skill** — new `domains/financial/skills/<name>.md` with
   `name`/`domain`/`requires`/`references` frontmatter (see any existing
   skill for the shape); add it to `skills/INDEX.md`'s list.
2. **Needs new context** — add a fetcher to `contextTools.ts`'s
   `contextTools` map, following the existing cache-first pattern (`quote`,
   `fundamentals`): read `snestack.db`'s cache first, fall back to a
   logged live fetch only on a miss/stale read. Never make `run-skill`
   call Finnhub/Twelve Data/Morningstar directly — only `data-refresh`
   does that.
3. **Needs a numeric threshold** — put it in `references/quality-bar.md`,
   not in the skill body or in code.
4. **Adding a deterministic tool** — new `agents/<name>Agent.ts` (extend
   `BaseAgent`/`ThrottledAPIAgent` if it's API-calling) or `tools/` for a
   non-agent utility; test it under
   `node/tests/domains/financial/agents/`.
5. **Touching a skill that runs on a cron** (`long-term-quality`,
   `swing-trading-large-cap`) — check its `gate:` frontmatter still makes
   sense for the change; a new recurring skill should declare one too
   (see `core/gate.ts`).
6. Run `npm run typecheck && npm run lint && npm test` before opening the
   PR, same as any other change.

## What you never do

Add any code path that places a trade, auto-approves a signal, or writes
to `quality-bar.md`/a company's `brain/` thesis file without the owner
having written that content themselves. Implementation stops at a PR a
human reviews — see `core/skills/eng.md`'s own line on this.
