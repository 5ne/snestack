---
name: vision
scope: harness
type: vision
---

# Vision: snestack (the harness)

**Purpose of this file:** context for whoever — human or agent — is deciding
what to build next *in the harness itself* (`core/`, `cli.ts`,
`config/domains.json`, the cross-domain automation around the PM/eng roles and
`feature-requests`). Not a skill that's ever run through `run-skill` — there's
no domain called "harness" in `config/domains.json`, and there shouldn't be.
Read this before triaging a feature request, writing a spec for one, or
implementing one. A domain gets its own `vision.md` once it's mature enough
to need domain-scoped judgment calls — today that's only
`domains/financial/skills/vision.md` (see "Current state" below for why
calendar and travel don't have one yet). This file is for decisions that
touch more than one domain, or the harness `core/` surface all of them
share — including, below, exactly what `core/` is and what it expects of
every domain.

## Mission

Encode how one person (the repo owner) actually makes recurring judgment
calls, in markdown they can read and edit directly, and let deterministic
code do everything around that judgment — fetching data, caching it,
deciding when a fresh look is even warranted, parsing a verdict back out,
notifying, logging. The judgment itself stays legible prose, not application
logic, so it can be argued with, revised, and trusted the way the owner's
own notes are trusted. "Thin harness, fat skills" (Garry Tan's framing) is
not an implementation detail — it's the actual thesis: the harness should
stay boring and small forever, and all the interesting, debatable,
improving-over-time material should live in `skills/*.md` and `brain/`,
both of which are just text.

This is a single-user system built for its owner's own decisions. It is not,
and has no ambition to become, a multi-tenant product, a SaaS, or something
pitched at "users" in the plural. Every design choice should be judged
against "does this make the owner's own judgment easier to encode and trust
more," not "would this scale to other people" or "is this impressive as
software."

## Core principles (non-negotiable — a feature request that violates one of
these needs to change shape, not get waived through)

1. **Judgment lives in markdown, never in code.** If a proposed change moves
   a decision rule out of a skill `.md` file and into TypeScript, that's a
   regression even if the code is cleaner — it makes the judgment harder to
   read and edit than prose was. Thresholds and numeric defaults belong in
   `references/*.md` files skills read from (see
   `domains/financial/skills/references/quality-bar.md`), not hardcoded.
2. **Ingestion and judgment are separate, and ingestion is the only thing
   that calls external APIs.** A skill (`run-skill`) only ever reads an
   already-cached context; a separate, explicitly-scheduled step
   (`data-refresh` in the financial domain; the equivalent for any future
   domain with a paid or rate-limited API) is the only thing that ever calls
   out live. This is what makes cost and API-quota predictable and auditable
   — never collapse the two to save a layer of indirection.
3. **Gate before you spend a model call.** A skill that runs on a timer
   should declare a `gate:` (see `core/gate.ts`) so a quiet day costs
   assembly time, not a Claude call. Every new recurring automation should
   ask "what's the gate?" before it asks "what's the prompt?"
4. **`core/` stays domain-agnostic, permanently.** If implementing a feature
   requires an `if (domain === "financial")` inside `core/`, the feature is
   misplaced — it belongs in that domain's `contextTools.ts` or its own
   module. This is the harness's actual moat: a domain this harness has
   never heard of (see `domains/travel/`, added after both others) should
   be addable by writing markdown and one `contextTools.ts`, with zero edits
   to `core/`. `CONTRIBUTING.md`'s "Adding a new domain" section is the test
   — if following it requires touching `core/`, something regressed.
5. **Nothing here executes anything consequential on its own.** No domain's
   automation places a trade, sends an irreversible message, merges a PR, or
   deletes data without a human-initiated step in between. The financial
   domain never auto-trades (see its own `vision.md`); the PM role never edits
   source code, only ever writes a new file under `feature-requests/` for a
   human to read and decide on (`core/featureRequests.ts`'s own docstring
   calls this "the hard safety line" — treat that phrase literally,
   everywhere it could apply to a new automation). Any future "SWE agent"
   that implements an approved feature request stops at a PR / a diff a
   human reviews — it does not merge or deploy itself. Any future "PM agent"
   that triages or prioritizes feature requests stops at a recommendation —
   it does not silently close or reject one.
6. **Cost and model tier are a design decision, not an afterthought.** A
   skill's `model: cheap|normal|expensive` frontmatter and `run.json`'s
   recorded `est_cost_usd` exist so a human can actually see what judgment
   costs over time. A new automation that runs often should default toward
   `cheap`/gated rather than `expensive`/always-on.
7. **The brain is durable, the code is disposable.** `brain/`, `reports/`,
   and the signal history (all outside the repo, under `SNESTACK_BRAIN_ROOT`, or in the hosted database) are
   the actual accumulated asset — years of stated thesis, signal history,
   trip records. The harness and skills exist to read and grow that asset
   faithfully. If a refactor would silently lose or reinterpret something
   already written there, that's a blocker, not a cleanup.

## How the harness is actually architected

This is the part a SWE agent needs precisely, not just in spirit — both to
implement a feature request correctly and to judge whether a proposal
belongs in `core/` at all (principle 4) or is secretly domain work wearing
a harness-level costume.

### The call chain

```
CLI (cli.ts): snestack run-skill <domain> <skill> <subject>
    ↓
core/domainRegistry.ts   getDomainConfig(domain) → { skillsDir, contextToolsModule }
                          reads config/domains.json; throws on an unregistered domain
    ↓
core/skillLoader.ts      loadSkillFile(skillsDir/<skill>.md)
                          → { frontmatter, body } — a thin YAML-frontmatter +
                            markdown-body parser, nothing domain-specific in it
    ↓
core/runSkill.ts          assembleSkillPrompt(domain, skill, subject):
                           - resolves frontmatter.requires[] by calling
                             contextTools[key](subject) for each key, in parallel
                           - resolves frontmatter.references[] by reading
                             skillsDir/references/<name>.md verbatim
                           - assembles one user prompt: SUBJECT, SKILL DEFINITION
                             (the skill's own markdown body), then a CONTEXT
                             block with one section per required/referenced item
                           - picks the model tier from frontmatter.model
                             (cheap|normal|expensive, default normal)
    ↓
core/executor.ts           runPrompt(apiKey, systemPrompt, userPrompt, {tier, maxTokens})
                           — the only place that calls the Claude API for a skill
    ↓
core/verdict.ts            parseVerdict(output) — if frontmatter.verdict: true,
                           extracts the trailing `VERDICT: LABEL | confidence |
                           reasoning` line deterministically; raw prose otherwise
```

`core/runSkill.ts` is deliberately the harness's *only* entry point for
running a skill — nothing upstream of it (a CLI command, a cron script)
touches `skillLoader`, `domainRegistry`, or `executor` directly. A gated
run goes through the same file's `evaluateSkillGate(domain, skill,
subject)` first: it loads the skill's `gate:` frontmatter, asks that
domain's own `gateFacts` function (via `domainRegistry.loadGateFacts`) for
the deterministic facts the gate needs (RSI, last-run time, etc.), and
calls `core/gate.ts`'s pure `evaluateGate(cfg, facts)` — no model, no
network, fails open (runs) on missing data or any error. Every gate
decision is recorded through `core/runLog.ts`'s `logRunEvent`, whether or
not the skill actually ran.

### What every module in `core/` actually owns

- `skillLoader.ts` — parses a skill file's YAML frontmatter + body. Knows
  nothing about what any frontmatter key *means* beyond its own type
  (`requires`, `references`, `model`, `gate`, `verdict`, `maxTokens`) —
  interpreting them is `runSkill.ts`'s job.
- `domainRegistry.ts` — the only file that reads `config/domains.json`. Two
  jobs: resolve a domain's `skillsDir`, and dynamically `import()` its
  `contextToolsModule` to get its `contextTools` map (and optional
  `gateFacts` function). This is the one deliberate seam where `core/`
  reaches into domain-specific code — through a fixed interface
  (`ContextToolMap`, `GateFactsFn` — see `core/contextTools.ts`'s type
  definitions), never by name-checking the domain string anywhere else.
- `runSkill.ts` — prompt assembly + the gate check + the one call into
  `executor.ts`. `assembleSkillPrompt` is split out from `runSkill` itself
  specifically so a caller that can't run the model here (travel's Gmail
  gap is the existing example) can still get the fully-assembled prompt
  to run somewhere that does, through `snestack <domain> prep-<skill>`-style
  commands — see travel's `prep-catalog`.
- `executor.ts` — the only code in the repo that calls the Claude API for a
  skill run (`core/email.ts` and provider API calls are separate, lower
  layers domains own themselves). Owns model-tier → model-ID mapping and
  retry/error handling for that one call.
- `gate.ts` / `verdict.ts` — both pure, synchronous, deterministic,
  model-free. `gate.ts` decides *whether* to spend a model call;
  `verdict.ts` deterministically parses structured meaning back out of one
  that already happened. Neither ever needs a test double for an API.
- `config.ts` / `db.ts` — shared plumbing (env vars including
  `SNESTACK_BRAIN_ROOT`, the model-tier table, the database connection). A
  domain reads these; it doesn't reimplement them.
- `runLog.ts` / `runCheck.ts` / `runReport.ts` — the automation-observability
  layer: every cron-run shell script (see "Scheduled automation" below)
  writes step-by-step events through `runLog.ts`, staged locally
  under `~/Library/Logs/snestack/runs/` and published into
  `<brain>/<domain>/...` when the run finishes; `runCheck.ts` reads those
  back across domains to flag missing/failed/degraded runs and stale
  cache, which the PM role reads when looking for improvements.
- `featureRequests.ts` — reads feature-request proposal files and
  rewrites their `status` for `feature approve|start|done`. Proposals
  themselves are authored by the PM role (`scripts/pm-daily.sh`), not by a
  skill inside the harness.
- `safeWrite.ts` — the one sanctioned way any automation writes a file
  under `<brain>/`, atomically. A domain script should use it rather than
  `fs.writeFileSync` directly, so a crash mid-write can't corrupt a
  canonical file.

### What `core/` expects of every domain — the actual contract

A domain registers itself in `config/domains.json` with two required fields
and an optional `scriptsDir`:

```json
"<domain>": {
  "skillsDir": "domains/<domain>/skills",
  "contextToolsModule": "domains/<domain>/contextTools",
  "scriptsDir": "domains/<domain>/scripts"
}
```

That's the entire interface `core/` depends on. Concretely, a domain must
provide:

1. **`domains/<domain>/skills/*.md`** — one file per skill, each with YAML
   frontmatter (`name`, `domain`, optionally `requires: [...]`,
   `references: [...]`, `model: cheap|normal|expensive`, `gate: {...}`,
   `verdict: true|false`, `maxTokens`) and a markdown body that *is* the
   judgment prompt. `requires` keys and `references` names are the domain's
   own vocabulary — `core/` never validates them against anything beyond
   "does the domain's `contextTools` map have this key" (logging a warning
   and continuing with `null` if not, rather than failing the run).
2. **`domains/<domain>/skills/references/*.md`** (optional) — static
   markdown any skill in the domain can pull in by name via `references:`.
   This is where shared numeric thresholds/defaults belong (principle 1) —
   see `financial/skills/references/quality-bar.md`.
3. **`domains/<domain>/contextTools.ts`** exporting:
   - `contextTools: ContextToolMap` — a `Record<string, (subject: string) =>
     Promise<unknown>>`. Each entry is one `requires` key a skill can ask
     for. This is where a domain reads its own cache/db/API/filesystem —
     `core/` calls these functions and otherwise has no idea what's inside
     them.
   - `gateFacts?: GateFactsFn` (optional) — `(skillName, subject) =>
     Promise<GateFacts>`, supplying whatever a skill's `gate:` config needs
     to evaluate (RSI, last-run timestamp, etc.). Only needed if any skill
     in the domain declares a `gate:`.
4. **`domains/<domain>/scripts/*.sh`** (optional) — registered via
   `scriptsDir` in `config/domains.json` and discoverable through
   `domainRegistry.ts` (`listDomainScripts` / `listAllDomainScripts`) and
   `snestack scripts`. Shared cron bootstrap (`rl_bootstrap`,
   `rl_default_failure_hook`, per-script locking, and staging/publishing)
   lives in `scripts/lib/run-log.sh`. Top-level `node/scripts/` holds
   `scripts/lib/`, diagnostic scripts (`agy-cli-test.sh`,
   `claude-cli-test.sh`), and thin `exec` compatibility shims for existing
   cron entries.
5. **Deterministic ingestion code** (optional, domain-owned, no fixed
   shape `core/` enforces) — financial's `agents/` (API-calling, one class
   per data source), `tools/` (PDF parsing, file organizing), and
   `providers/` (`QuoteProvider`/`FundamentalsProvider` interfaces behind
   `agents/`) are that domain's own answer to "ingestion is separate from
   judgment" (principle 2); a new domain with a similar need should follow
   the same shape, but nothing in `core/` requires these specific
   directory names.

The test for whether something belongs in `core/` versus inside a domain:
can every other domain ignore it completely and keep working? `gate.ts`
evaluating a `GateConfig` — yes, any domain can leave `gate:` off entirely.
A new `rsiBelow` *concept* baked into `core/` instead of staying a generic
numeric field in `GateConfig` — no, that's financial-specific language
leaking upward, and it hasn't (the field is generic on purpose, even though
only financial uses it today).

## Current state (as of 2026-10, see `README.md` for anything more current)

Three domains are registered in `config/domains.json`: `financial` (the
original use case — portfolio/watchlist investment judgment, the only
domain with its own `vision.md`, its own PM and eng skills, and the richest
`contextTools.ts`), `calendar` (read-only Google Calendar, one skill,
built specifically to prove the harness generalizes beyond investing —
still too thin for a domain-scoped vision to say anything a sentence in
this file couldn't), and `travel` (cataloging past trips from Gmail +
Google Maps Timeline into `brain/travel/<year>/` — the first domain the
harness can't fully run end-to-end itself, since it has no Gmail access of
its own, and whose automated path is deprecated — also too unsettled right
now for its own vision doc to be worth maintaining). Write a `vision.md`
for calendar or travel once real feature-request pressure or real
domain-specific judgment calls show up for either — not preemptively.

Self-improvement runs through two scheduled roles. The PM role
(`scripts/pm-daily.sh`) reads recent run records and writes zero or more
`status: proposed` files under `<brain>/<domain>/feature-requests/<date>-<slug>.md`
(an earlier `improve-self` skill and `snestack reflect` did this inside the
harness and were removed as redundant). A human reviews them with
`snestack feature list` and moves one `proposed` → `approved` (the human
step). The eng role (`scripts/eng-daily.sh`) picks up `approved` ones and
moves them `in-progress` (via `feature start`); `done` is marked by hand
after the PR merges. Neither role pushes or merges.

## What this vision unlocks: the next layer

The concrete reason this file exists is to be the shared context a **PM
agent** and a **SWE agent** read before touching anything upstream of
the PM role's own proposals:

- A **PM agent**, triaging the growing pile of files under
  `<brain>/*/feature-requests/`, should read this file plus the relevant
  domain's `vision.md` if one exists (today, only financial's) to decide
  whether a proposal is worth doing *now* (does it serve the mission above,
  does it respect every non-negotiable principle, is its `Impact`/`Effort`
  pairing actually favorable) versus worth deferring or rejecting outright
  — and should write that reasoning down somewhere reviewable, not just
  reorder a list silently. For a domain with no `vision.md` yet (calendar,
  travel), this file plus "What `core/` expects of every domain" above is
  the whole picture — don't invent domain-scoped principles that don't
  exist yet just to have something to cite.
- A **SWE agent**, implementing an approved proposal, should read this file
  (especially "How the harness is actually architected" above) plus
  `CONTRIBUTING.md` plus the relevant domain's `vision.md` if one exists,
  and should produce a normal PR a human reviews — same as any other
  contribution. Nothing about automating this step relaxes principle 5
  above.

Neither agent should treat this file as a backlog — it deliberately has no
dated roadmap items (those live in `README.md`'s Roadmap section and in
`feature-requests/`, both of which change often). This file is the stable
backdrop those changing lists get judged against. Expect it to change far
less often than either of them; when the owner's actual priorities shift
enough that a principle above no longer holds, update this file explicitly,
in its own commit, with a clear reason — don't let it drift out of sync
with reality by neglect.

## Non-goals

- Not a product for other people. No accounts, no multi-tenancy, no
  onboarding flow for "a user" who isn't the owner.
- Not a general-purpose agent framework. The harness is deliberately small;
  resist generalizing `core/` for a hypothetical future need that no real
  domain has asked for yet (see principle 4 — and `README.md`'s own
  roadmap note on non-linear orchestration: explicitly deferred "once
  enough skills exist per domain to make that worth building," not before).
- Not a place for autonomous, irreversible action of any kind — financial,
  communicative, or git/code — regardless of how much judgment quality
  improves. Principle 5 is permanent, not a bootstrapping-phase caveat.
