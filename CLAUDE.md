# snestack - Personal Decision-Support Harness

A "thin harness, fat skills" system for encoding how the user actually thinks about a decision — not a single-purpose tool. Deterministic code fetches data; markdown skill files hold the judgment; a domain-agnostic core harness loads a named skill, resolves the context it declares it needs, and runs it through Claude. `domains/financial/` (investment recommendations across a portfolio/watchlist, based on the user's own stated investment philosophy) was the original domain; `domains/calendar/` (read-only Google Calendar) is the second, added specifically to prove the harness generalizes beyond investing. More domains are expected — anywhere the pattern "fetch some data, apply my own judgment to it" shows up in the user's life is a candidate.

## Setup

### gstack Installation (Required)

This project uses gstack for development workflows. Install it with:

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
```

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.

### Available gstack Skills

- `/office-hours` - Schedule and manage office hours
- `/plan-ceo-review` - Plan CEO reviews
- `/plan-eng-review` - Plan engineering reviews
- `/plan-design-review` - Plan design reviews
- `/design-consultation` - Get design consultation
- `/design-shotgun` - Rapid design iteration
- `/design-html` - Convert designs to HTML
- `/review` - Code review
- `/ship` - Deploy and ship
- `/land-and-deploy` - Landing and deployment
- `/canary` - Canary deployments
- `/benchmark` - Performance benchmarking
- `/browse` - Web browsing (preferred over Chrome tools)
- `/connect-chrome` - Chrome connection setup
- `/qa` - QA testing
- `/qa-only` - QA only testing
- `/design-review` - Design review
- `/setup-browser-cookies` - Configure browser cookies
- `/setup-deploy` - Setup deployment
- `/setup-gbrain` - Setup gBrain
- `/retro` - Retrospectives
- `/investigate` - Investigation and debugging
- `/document-release` - Document releases
- `/document-generate` - Generate documentation
- `/codex` - Code search and documentation
- `/cso` - Chief Security Officer functions
- `/autoplan` - Automatic planning
- `/plan-devex-review` - Plan developer experience reviews
- `/devex-review` - Developer experience review
- `/careful` - Careful mode for critical operations
- `/freeze` - Freeze deployments
- `/guard` - Guard rails and safety checks
- `/unfreeze` - Unfreeze deployments
- `/gstack-upgrade` - Upgrade gstack
- `/learn` - Learning and documentation

## Architecture: thin harness, fat skills

This project follows Garry Tan's "thin harness, fat skills" model, fully migrated (see git history on `move-to-skills-based` for the six-step migration). Layout:

- `node/src/core/` — domain-agnostic harness: `skillLoader` (parses skill frontmatter), `domainRegistry` (reads `config/domains.json`, loads a domain's `contextTools`), `executor` (runs a prompt through Claude), `runSkill(domain, skill, subject)` (the actual entry point), plus `db`, `config`, `scheduler`, `logger`, `errors`. Never references anything domain-specific.
- `node/src/config/domains.json` — registers each domain's `skillsDir` and `contextToolsModule`.
- `node/src/domains/financial/` — the investing domain: `skills/` (start at `skills/INDEX.md` — `long-term-quality.md`, `swing-trading-large-cap.md`, `private-company-eval.md` draft, `references/quality-bar.md`), `agents/` (deterministic tools: quote, equity, strategy, trader — plus the deprecated `cfoAgent.ts`), `tools/` (Morningstar PDF parsing, report organizing), `providers/` (`QuoteProvider`/`FundamentalsProvider` interfaces — Finnhub and Morningstar are swappable implementations), `contextTools.ts`, `orchestrator.ts` (deprecated).
- `node/src/domains/calendar/` — read-only Google Calendar domain, stood up specifically to validate the harness generalizes: `skills/daily-agenda.md`, `googleAuth.ts`, `setup.ts` (OAuth bootstrap), `tools/calendarClient.ts`, `contextTools.ts`.
- `brain/` — one file per company under `brain/investing/public/companies/` (public-market names), holding the user's own stated thesis plus a dated history. Lives outside the repo now, in the shared Google Drive folder at `~/Documents/personal-brain/financial/brain/` (see `.gitignore` and `node/README.md`'s Database section) — not committed here.

**Current path**: `snestack run-skill <domain> <skill> <subject>` — loads the skill's frontmatter, resolves `requires`/`references` via that domain's context tools, runs the assembled prompt through Claude. **Legacy path**: `snestack analyze`/`batch` still run `orchestrator.ts` → the deprecated `CfoAgent` (hardcoded judgment, bypasses skills/brain entirely) — kept for reference per commit `bbac31b`, prints a deprecation warning, not the intended way to invoke judgment anymore.
