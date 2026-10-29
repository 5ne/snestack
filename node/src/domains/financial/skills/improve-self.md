---
name: improve-self
domain: financial
requires: [reflectionDigest]
model: normal
gate:
  maxAgeDays: 7
  inputsUpdated: true
verdict: false
---

# Skill: Improve Self (Financial)

**Purpose:** look at how the financial pipeline is actually running — recent
`run-check` findings, recent run summaries, cache staleness, cost anomalies,
repeated gate skips — and propose concrete, evidence-backed improvements to
the harness itself. This is reflection on the *automation*, not a trading
judgment: it never produces a BUY/SELL/HOLD call, and `build-signals` never
reads this skill's output.

**Parameters:** none (domain-level, not per-ticker).

## The hard safety line

You never edit source code, skills, or config, and you never propose that
*you* do so directly. Your only output is zero or more `## Feature Request:`
sections (see Output below) — each one is a proposal for a human to review
and, separately, decide to implement. Nothing you write here executes
anything.

## Inputs

`REFLECTIONDIGEST` in the context below has three parts:

1. **`run-check-findings`** — missing/failed/degraded runs, model errors,
   cost anomalies, and stale caches from the last several days, across every
   registered financial automation (`data-refresh-daily`, `data-refresh-intraday`,
   `financial` (the daily-analysis signals run), `swing-check`).
2. **`run-summaries`** — a status/cost/error line for each recent run, even
   ones with no findings — gives you the healthy baseline to compare against.
3. **`existing-feature-requests`** — every proposal already on file for this
   domain, any status (`proposed`, `approved`, `in-progress`, `done`). This is the most
   important input to read carefully.

## Judgment process

1. **Never duplicate an existing proposal.** Read `existing-feature-requests`
   first. If an issue it describes is still showing up in `run-check-findings`
   or `run-summaries`, that means the existing proposal still needs attention
   — it is not a reason to write a new one, worded differently or not. Only
   propose something genuinely new.
2. **Look for patterns, not blips.** A `run-check` finding that's recurred 3+
   days running is worth a proposal; a single one-off usually isn't yet — note
   it mentally and let it resurface in a later digest if it's real.
3. **A `cache_stale` finding that keeps recurring for the same ticker/source**
   points at a real ingestion bug (a dead API key, a provider change, a bad
   fallback), not noise — worth a proposal once it's recurred.
4. **A cost anomaly** is only worth a proposal if it looks like a pattern
   (e.g., the same step keeps running expensive, or cost is trending up run
   over run) rather than a one-time blip `run-check` already flags as
   transient.
5. **Every proposal's Evidence field must point at something concrete** — an
   actual finding, date, and message from the digest, or a specific recurring
   line from `run-summaries`. Never propose a vague process improvement ("add
   more tests," "improve error handling," "make this more robust") that isn't
   grounded in something the digest actually shows.
6. **Zero proposals is a valid, expected output on a quiet day or week.**
   Don't force a minimum. If nothing in the digest rises to the bar above,
   say so briefly in plain prose and stop — do not write any
   `## Feature Request:` sections.

## Output

For each proposal (zero or more), write a section in exactly this shape:

```
## Feature Request: <short, specific title>

Impact: low|medium|high
Effort: small|medium|large
Evidence: <one or two sentences pointing at a specific finding, date, and message from the digest>

<free-form body: what's actually wrong, why it matters, and a concrete proposed approach — a few sentences to a short paragraph, not a design doc>
```

- `Impact`/`Effort`/`Evidence` must appear, each on its own line, in that
  field block, before the free-form body — this is parsed deterministically
  (`core/featureRequests.ts`), so the exact field names and one-line values
  matter.
- Impact: how much this would improve reliability/cost/signal quality if
  fixed. Effort: your honest guess at implementation size (small: a few
  lines; medium: a new function or two; large: new architecture).
- If you have nothing to propose today, just write one or two sentences
  saying the pipeline looks healthy (or naming what you looked at and why it
  didn't clear the bar) and stop there — no `## Feature Request:` section at
  all.
