# fstack - Personal Investment Philosophy System

A system to make investments across public and private companies based on how a user thinks about making investments (their personal investment philosophy). The system orchestrates multiple integrated agents including research analyst, equity analyst, CFO, strategy, and trader roles.

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

## Investment Philosophy: Skills & Brain (in progress)

This project is moving from hardcoded agent logic toward Garry Tan's "thin harness, fat skills" model. Two folders are being built out for this:

- `skills/` — markdown judgment skills (start at `skills/INDEX.md`). Currently: `long-term-quality.md` (buy-and-hold, thesis-driven) and `swing-trading-large-cap.md` (tactical RSI swings on eligible large-cap names only). These two can both apply to the same ticker.
- `brain/` — one file per company under `brain/investing/public/companies/` (public-market names; private holdings will get their own `brain/investing/private/` branch once any exist), holding the user's own stated thesis plus a dated history. Start at `brain/INDEX.md`.

**Not yet wired up**: `node/src/agents/strategyAgent.ts`, `equityAgent.ts`, and `cfoAgent.ts` still run their original hardcoded, generic logic — the skills above are drafts awaiting review. Don't assume the live `npm run dev -- batch` pipeline actually uses them yet.
