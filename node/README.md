# fstack — Node.js / TypeScript Implementation

The active implementation of fstack. Uses Node.js 22 with TypeScript, node:sqlite (built-in), and the Anthropic SDK.

## Prerequisites

- Node.js 22+
- npm

## Setup

```bash
cd node
npm install
cp .env.example .env
# Edit .env with your API keys
```

## Running the CLI

```bash
# Set the experimental sqlite flag (required for Node 22)
export NODE_OPTIONS=--experimental-sqlite

# First-time setup
npm run dev -- setup

# Add positions / watchlist
npm run dev -- position add NVDA 100 850.00
npm run dev -- watchlist add TSLA "waiting for dip"

# Analyze
npm run dev -- analyze NVDA
npm run dev -- batch --dry-run
npm run dev -- batch

# View signal history
npm run dev -- signals
npm run dev -- signals NVDA

# Retry failed notifications
npm run dev -- retry

# Organize freshly-downloaded Morningstar PDFs from reports/staging
npm run dev -- organize-reports

# Set up a daily cron job (run against the built CLI — `npm run build` first)
npm run build
npm run dev -- scheduler --setup
npm run dev -- scheduler --list
```

`setup` is fully interactive — it prompts for each API key, validates the
format, and writes `.env` for you, mirroring `fstack setup` in the Python
implementation. Twilio SMS credentials are collected and stored the same way
Python collects them, but neither implementation actually sends SMS yet —
only email notifications are wired up.

## Tests

```bash
NODE_OPTIONS=--experimental-sqlite npm test
NODE_OPTIONS=--experimental-sqlite npm run test:coverage
```

204 tests across 16 suites — all passing.

## Database

Points to `../fstack.db` (the shared root database) via `FSTACK_DATABASE_PATH` in `.env`. Override by setting a different path in `.env`.

## Project Layout

```
node/
├── src/
│   ├── core/          # db, config, setup, models, errors, logger
│   ├── agents/        # quote, strategy, equity, cfo, trader
│   ├── tools/         # morningstar PDF parser, report organizer
│   ├── orchestrator.ts
│   ├── scheduler.ts   # cron install/list for daily batch runs
│   └── cli.ts
└── tests/             # Jest test suite (mirrors src/)
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FSTACK_FINNHUB_API_KEY` | Yes | Finnhub quote data |
| `FSTACK_CLAUDE_API_KEY` | Yes | Claude API (CFO synthesis) |
| `FSTACK_GMAIL_ADDRESS` | Yes | Gmail sender address |
| `FSTACK_GMAIL_APP_PASSWORD` | Yes | Gmail app password |
| `FSTACK_NOTIFICATION_EMAIL` | Yes | Where to send signals |
| `FSTACK_DATABASE_PATH` | No | DB path (default: `../fstack.db`) |
| `FSTACK_TWILIO_ACCOUNT_SID` | No | SMS via Twilio |
| `FSTACK_TWILIO_AUTH_TOKEN` | No | SMS via Twilio |
| `FSTACK_SMS_PHONE` | No | SMS recipient number |
