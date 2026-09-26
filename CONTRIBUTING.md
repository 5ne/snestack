# Contributing to snestack

Thank you for your interest in contributing! This guide explains how to set up your development environment and contribute code.

## Development Setup

### Prerequisites
- Node.js 22+
- npm
- git
- Google Drive for Desktop (syncs `~/Documents/personal-brain/` — see below)

### Install for Development

```bash
git clone https://github.com/5ne/snestack.git
cd snestack

cd node
npm install
cp .env.example .env
# Edit .env with your API keys
```

### Shared data (`brain/`, `reports/`, the db)

None of this lives in the repo — it's all in the Google Drive-synced folder at `~/Documents/personal-brain/`, which is how it stays in sync across machines without git (no LFS needed). See `.gitignore` and each subfolder's own README:
- `~/Documents/personal-brain/financial/brain/` — per-company thesis notes
- `~/Documents/personal-brain/financial/reports/` — Morningstar PDFs (see that folder's README for the download/organize workflow)
- `~/Documents/personal-brain/financial/snestack.db` — the sqlite db

Override the root with `SNESTACK_BRAIN_ROOT` in `.env` if you move the shared folder.

### Run Tests

```bash
cd node
export NODE_OPTIONS=--experimental-sqlite

# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

### Code Quality

```bash
cd node

# Lint
npm run lint

# Type check
npm run typecheck

# All together
npm run typecheck && npm run lint && npm test
```

## Architecture Overview

snestack is a "thin harness, fat skills" system: `core/` is a domain-agnostic harness (skill loader, context assembler, executor, scheduler, db, config), and each domain under `domains/` supplies its own skills (markdown judgment), deterministic tools, and a `contextTools.ts` map the harness resolves skill `requires` against.

```
CLI: snestack run-skill <domain> <skill> <subject>
    ↓
core/runSkill: loads skill frontmatter, resolves `requires` via
that domain's contextTools, assembles the prompt
    ↓
core/executor: runs the prompt through Claude
    ↓
raw model output (the skill's judgment, in prose)
```

The financial domain also has an older, deprecated multi-agent pipeline (`orchestrator.ts` → `CfoAgent`) that hardcodes judgment directly in TypeScript instead of going through skills — kept for reference via the `analyze`/`batch` CLI commands, not the pattern to extend.

## Key Files

```
node/src/
├── cli.ts                        ← Main entry point
├── core/                         ← domain-agnostic harness
│   ├── db.ts, config.ts, setup.ts, models.ts, logger.ts, errors.ts
│   ├── scheduler.ts              ← cron install/list
│   ├── skillLoader.ts            ← parses a skill file's frontmatter + body
│   ├── domainRegistry.ts         ← reads config/domains.json, loads a domain's contextTools
│   ├── executor.ts               ← runs a prompt through Claude
│   └── runSkill.ts               ← the actual runSkill(domain, skill, subject) entry point
├── config/
│   └── domains.json              ← registers each domain's skillsDir + contextToolsModule
└── domains/
    ├── financial/
    │   ├── skills/                ← markdown judgment (start at skills/INDEX.md)
    │   ├── agents/                ← deterministic tools: quote, equity, strategy, trader
    │   │                          ← (+ deprecated cfoAgent.ts)
    │   ├── tools/                 ← Morningstar PDF parsing, report organizing
    │   ├── providers/             ← QuoteProvider/FundamentalsProvider interfaces
    │   ├── contextTools.ts
    │   └── orchestrator.ts        ← deprecated pipeline
    └── calendar/
        ├── skills/
        ├── tools/calendarClient.ts
        ├── googleAuth.ts, setup.ts
        └── contextTools.ts
```

## Adding a skill to an existing domain

1. Create `node/src/domains/<domain>/skills/mySkill.md` with `name`/`domain`/`requires`/`references` frontmatter (see any existing skill file for the shape).
2. If it needs new context, add a fetcher to that domain's `contextTools.ts`.
3. Run it: `snestack run-skill <domain> mySkill <subject>`.

## Adding a new domain

1. Create `node/src/domains/<name>/` with `skills/` and a `contextTools.ts` exporting `contextTools: ContextToolMap`.
2. Register it in `node/src/config/domains.json` (`skillsDir`, `contextToolsModule`).
3. No changes to `core/` should be necessary — if you find yourself editing `core/`, that's a sign something domain-specific leaked in there.

## Adding a deterministic tool (financial domain)

1. Create `node/src/domains/financial/agents/myAgent.ts` (or `tools/` for a non-agent utility).
2. Extend `BaseAgent`/`ThrottledAPIAgent` (see `agents/base.ts` for retry/throttle helpers) if it's an agent.
3. Implement `async analyze(ticker: string, ...): Promise<Result | null>`.
4. Add tests in `node/tests/domains/financial/agents/`.
5. Expose it through `contextTools.ts` if a skill should be able to `require` it.

## Adding a New CLI Command

1. Add a `commander` subcommand in `cli.ts`:
```ts
program
  .command("mycommand")
  .description("Description")
  .option("--option <value>", "Option help")
  .action(async (opts) => {
    // Your logic
  });
```

2. Add tests in `node/tests/cli.test.ts` (spawns the real CLI as a smoke test).

## Testing Guidelines

- Write unit tests for new agents (`node/tests/domains/<domain>/agents/`)
- Write integration/CLI smoke tests for new commands
- Mock external APIs (Finnhub, Claude, Gmail) rather than hitting them in tests
- Use the shared fixtures under `node/tests/core/` for database tests

## Commit Message Format

Follow conventional commits:

```
feat: add X feature
fix: fix Y bug
docs: update README
test: add tests for X
refactor: refactor Y module
chore: update dependencies
```

## Reporting Issues

Before opening an issue, check:
1. Is this a duplicate? Search existing issues
2. Can you reproduce it? Include steps
3. What's your environment? Node version, OS
4. What do you expect? vs. What actually happened?

## Proposing Features

1. Open an issue describing the feature
2. Discuss approach before coding
3. Implementation follows architecture guidelines
4. Include tests
5. Update docs
6. Submit PR with reference to issue

## Code Review

All PRs require review before merge. We look for:
- Tests pass
- Code formatted and linted (`npm run lint`, `npm run typecheck`)
- Follows architecture patterns
- No breaking changes (or major version bump)
- Docs updated if needed

## Questions?

- Open a GitHub discussion
- Check existing issues
- Read the README and docs

Thank you for contributing!
