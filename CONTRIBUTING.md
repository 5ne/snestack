# Contributing to fstack

Thank you for your interest in contributing! This guide explains how to set up your development environment and contribute code.

## Development Setup

### Prerequisites
- Node.js 22+
- npm
- git
- git-lfs (for syncing Morningstar reports across machines)

### Install for Development

```bash
git clone https://github.com/yourusername/fstack.git
cd fstack

# Install git-lfs (for syncing Morningstar reports)
brew install git-lfs  # macOS
# or apt-get install git-lfs  # Linux
git lfs install

cd node
npm install
cp .env.example .env
# Edit .env with your API keys
```

### Morningstar Reports

Reports are stored in `reports/` at the repo root and synced via Git LFS across all machines.

**To add a report (manual, until Schwab automation is complete):**
1. Log into Schwab → Research
2. Search for ticker (e.g., "MU")
3. Download Morningstar PDF to `reports/{TICKER}-morningstar.pdf`
4. Commit and push:
   ```bash
   git add reports/MU-morningstar.pdf
   git commit -m "data: add MU Morningstar report"
   git push
   ```

**Automated download (planned):**
```bash
npm run dev -- download-reports MU NVDA GOOG
```

**To pull reports on another machine:**
```bash
git pull          # Automatically fetches LFS files
git lfs pull      # If LFS files don't sync automatically
```

See `reports/README.md` for more details.

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

fstack follows a multi-agent architecture:

```
User Input (CLI)
    ↓
[Config] + [Database]
    ↓
Agents:
  - QuoteAgent: Finnhub API → OHLCV + indicators
  - StrategyAgent: Rules engine → BUY/SELL/HOLD signals
  - EquityAgent: Fundamentals API → PE, FCF, red flags
  - CFOAgent: Claude → final synthesis
  - TraderAgent: Email/SMS → send notifications
    ↓
[Database] → storage
    ↓
User: Email notification
```

## Key Files

```
node/src/
├── cli.ts               ← Main entry point
├── orchestrator.ts       ← Pipeline orchestration
├── scheduler.ts          ← Cron install/list for daily batch runs
├── core/
│   ├── db.ts            ← SQLite schema + queries
│   ├── config.ts        ← Environment config + key validation
│   ├── setup.ts         ← Interactive setup
│   ├── models.ts        ← Zod data schemas
│   ├── logger.ts        ← Structured logging
│   └── errors.ts        ← Custom exceptions
├── agents/
│   ├── base.ts          ← BaseAgent + retry logic
│   ├── quoteAgent.ts
│   ├── strategyAgent.ts
│   ├── equityAgent.ts
│   ├── cfoAgent.ts
│   └── traderAgent.ts
└── tools/
    ├── morningstarParser.ts
    └── reportOrganizer.ts
```

## Adding a New Agent

1. Create `node/src/agents/myAgent.ts`
2. Extend `BaseAgent` (see `agents/base.ts` for retry/throttle helpers)
3. Implement `async analyze(ticker: string, ...): Promise<Result | null>`
4. Add tests in `node/tests/agents/`
5. Wire it into `orchestrator.ts`

Example:

```ts
import { BaseAgent } from "./base";

export class MyAgent extends BaseAgent {
  constructor() {
    super("MyAgent");
  }

  async analyze(ticker: string): Promise<MyResult | null> {
    try {
      return await this.fetchData(ticker);
    } catch (e) {
      this.logger.error(`Analysis failed: ${e}`);
      return null;
    }
  }

  private async fetchData(ticker: string): Promise<MyResult> {
    // Your logic here
  }
}
```

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

- Write unit tests for new agents (`node/tests/agents/`)
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
