# snestack - Personal Decision-Support Harness

A "thin harness, fat skills" system for encoding how the user actually thinks about a decision — not a single-purpose tool. Deterministic code fetches data; markdown skill files hold the judgment; a domain-agnostic core harness loads a named skill, resolves the context it declares it needs, and runs it through Claude. `domains/financial/` (investment recommendations across a portfolio/watchlist, based on the user's own stated investment philosophy) was the original domain; `domains/calendar/` (read-only Google Calendar) is the second, added specifically to prove the harness generalizes beyond investing. More domains are expected — anywhere the pattern "fetch some data, apply my own judgment to it" shows up in the user's life is a candidate.

## Setup

```bash
cd node
npm install
cp .env.example .env
# Edit .env with your API keys — see node/README.md
```

## Architecture: thin harness, fat skills

This project follows Garry Tan's "thin harness, fat skills" model, fully migrated (see git history on `move-to-skills-based` for the six-step migration). Layout:

- `node/src/core/` — domain-agnostic harness: `skillLoader` (parses skill frontmatter), `domainRegistry` (reads `config/domains.json`, loads a domain's `contextTools`), `executor` (runs a prompt through Claude), `runSkill(domain, skill, subject)` (the actual entry point), plus `db`, `config`, `scheduler`, `logger`, `errors`. Never references anything domain-specific.
- `node/src/config/domains.json` — registers each domain's `skillsDir` and `contextToolsModule`.
- `node/src/domains/financial/` — the investing domain: `skills/` (start at `skills/INDEX.md` — `long-term-quality.md`, `swing-trading-large-cap.md`, `private-company-eval.md` draft, `references/quality-bar.md`), `agents/` (deterministic tools: quote, equity, strategy, trader — plus the deprecated `cfoAgent.ts`), `tools/` (Morningstar PDF parsing, report organizing), `providers/` (`QuoteProvider`/`FundamentalsProvider` interfaces — Finnhub and Morningstar are swappable implementations), `contextTools.ts`, `orchestrator.ts` (deprecated).
- `node/src/domains/calendar/` — read-only Google Calendar domain, stood up specifically to validate the harness generalizes: `skills/daily-agenda.md`, `googleAuth.ts`, `setup.ts` (OAuth bootstrap), `tools/calendarClient.ts`, `contextTools.ts`.
- `brain/` — one file per company under `brain/investing/public/companies/` (public-market names), holding the user's own stated thesis plus a dated history. Lives outside the repo now, in the shared Google Drive folder at `~/Documents/personal-brain/financial/brain/` (see `.gitignore` and `node/README.md`'s Database section) — not committed here.

**Current path**: `snestack run-skill <domain> <skill> <subject>` — loads the skill's frontmatter, resolves `requires`/`references` via that domain's context tools, runs the assembled prompt through Claude. **Legacy path**: `snestack analyze`/`batch` still run `orchestrator.ts` → the deprecated `CfoAgent` (hardcoded judgment, bypasses skills/brain entirely) — kept for reference per commit `bbac31b`, prints a deprecation warning, not the intended way to invoke judgment anymore.
