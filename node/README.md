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

Lives outside the repo, in the shared Google Drive folder at `~/Documents/personal-brain/financial/fstack.db`, via `FSTACK_DATABASE_PATH` in `.env`. Override by setting a different path in `.env`.

## Project Layout

```
node/
├── src/
│   ├── core/                    # domain-agnostic harness: db, config, setup, models,
│   │                            # errors, logger, scheduler, skillLoader, domainRegistry,
│   │                            # executor, runSkill
│   ├── config/
│   │   └── domains.json         # registers each domain's skillsDir + contextToolsModule
│   ├── domains/
│   │   ├── financial/           # skills/, brain/ (external, see Database below), agents/,
│   │   │                        # tools/, providers/, contextTools.ts, orchestrator.ts
│   │   └── calendar/            # skills/, tools/, googleAuth.ts, setup.ts, contextTools.ts
│   └── cli.ts
└── tests/                       # Jest test suite (mirrors src/)
```

## Skill harness

`fstack run-skill <domain> <skill> <subject>` loads a skill markdown file's frontmatter (`name`/`domain`/`requires`/`references`), resolves its `requires` via that domain's `contextTools.ts`, and runs the assembled prompt through the model. This is the current, non-deprecated path — see `src/domains/financial/skills/INDEX.md` for the financial domain's skills, or `src/domains/calendar/skills/` for the calendar domain's.

```bash
fstack run-skill financial long-term-quality NVDA
fstack run-skill calendar daily-agenda today
```

### Calendar domain setup (Google Calendar, read-only)

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or reuse) a project, enable the **Google Calendar API**, then create an **OAuth client ID** of type **Desktop app** under Credentials.
2. Set `FSTACK_GOOGLE_CLIENT_ID` and `FSTACK_GOOGLE_CLIENT_SECRET` from that client in `.env`.
3. Run `fstack calendar auth` — it prints a consent URL, opens a local server to catch the redirect, and saves `FSTACK_GOOGLE_REFRESH_TOKEN` to `.env` for you. Read-only scope (`calendar.readonly`) only — nothing is ever written to your calendar.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FSTACK_FINNHUB_API_KEY` | Yes | Finnhub quote data |
| `FSTACK_CLAUDE_API_KEY` | Yes | Claude API (skill execution, CFO synthesis) |
| `FSTACK_GMAIL_ADDRESS` | Yes | Gmail sender address |
| `FSTACK_GMAIL_APP_PASSWORD` | Yes | Gmail app password |
| `FSTACK_NOTIFICATION_EMAIL` | Yes | Where to send signals |
| `FSTACK_DATABASE_PATH` | No | DB path (default: `~/Documents/personal-brain/financial/fstack.db`) |
| `FSTACK_BRAIN_ROOT` | No | Brain root (default: `~/Documents/personal-brain`) |
| `FSTACK_TWILIO_ACCOUNT_SID` | No | SMS via Twilio |
| `FSTACK_TWILIO_AUTH_TOKEN` | No | SMS via Twilio |
| `FSTACK_SMS_PHONE` | No | SMS recipient number |
| `FSTACK_GOOGLE_CLIENT_ID` | No | Calendar domain — Google OAuth "Desktop app" client ID |
| `FSTACK_GOOGLE_CLIENT_SECRET` | No | Calendar domain — Google OAuth client secret |
| `FSTACK_GOOGLE_REFRESH_TOKEN` | No | Calendar domain — written by `fstack calendar auth`, not set by hand |
