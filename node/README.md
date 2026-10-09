# snestack — Node.js / TypeScript Implementation

The active implementation of snestack. Uses Node.js 22 with TypeScript, node:sqlite (built-in), and the Anthropic SDK.

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

# Run a skill (current path — see "Skill harness" below)
npm run dev -- run-skill financial long-term-quality NVDA

# View signal history
npm run dev -- signals
npm run dev -- signals NVDA

# Organize freshly-downloaded Morningstar PDFs from
# ~/Documents/personal-brain/financial/reports/staging (override with SNESTACK_BRAIN_ROOT)
npm run dev -- organize-reports

# Full nightly long-term-quality pipeline (data-dump -> run-skill long-term-quality
# per ticker -> distill-signals -> notify).
./scripts/daily-analysis.sh
```

Four cron jobs together make up the split-cadence pipeline (`npm run build` first against each — all four scripts run the built CLI, not `npm run dev`). Times below are US/Eastern market hours; adjust for your own timezone and trading hours:

| Script | Cadence | What it does |
| --- | --- | --- |
| `scripts/data-refresh-intraday.sh` | every 30-60 min, market hours | Live quote price only (skips fundamentals) |
| `scripts/data-refresh-daily.sh` | nightly | Quote + RSI/MA + Finnhub fundamentals; Morningstar re-parse on Mondays only |
| `scripts/daily-analysis.sh` | nightly, after `data-refresh-daily.sh` | `long-term-quality` skill for every ticker, email + signal history |
| `scripts/swing-check.sh` | hourly, market hours | `swing-trading-large-cap` skill for every ticker, its own email + signal history |

```cron
# crontab -e  (adjust paths; each line's CRON_TZ sets that line's own timezone)
CRON_TZ=America/New_York */30 9-16 * * 1-5 cd <repo>/node && ./scripts/data-refresh-intraday.sh >> logs/data-refresh-intraday.cron.log 2>&1
CRON_TZ=America/New_York 0 17 * * 1-5 cd <repo>/node && ./scripts/data-refresh-daily.sh >> logs/data-refresh-daily.cron.log 2>&1
CRON_TZ=America/New_York 30 17 * * 1-5 cd <repo>/node && ./scripts/daily-analysis.sh >> logs/daily-analysis.cron.log 2>&1
CRON_TZ=America/New_York 0 10-16 * * 1-5 cd <repo>/node && ./scripts/swing-check.sh >> logs/swing-check.cron.log 2>&1
```

Each script supports `--dry-run` (runs everything but emails/records nothing, output goes to a `-dryrun` directory) and `--tickers A,B,C` (overrides the positions+watchlist default). `snestack run-check` summarizes recent runs across all four — see `node/src/core/runCheck.ts`.

`setup` is fully interactive — it prompts for each API key, validates the
format, and writes `.env` for you, mirroring `snestack setup` in the Python
implementation. Twilio SMS credentials are collected and stored the same way
Python collects them, but neither implementation actually sends SMS yet —
only email notifications are wired up.

## Tests

```bash
NODE_OPTIONS=--experimental-sqlite npm test
NODE_OPTIONS=--experimental-sqlite npm run test:coverage
```

174 tests across 13 suites, all passing.

## Database

Lives outside the repo, in the shared Google Drive folder at `<SNESTACK_BRAIN_ROOT>/financial/snestack.db` — derived from `SNESTACK_BRAIN_ROOT` in `.env` (default `~/Documents/personal-brain`), not set independently. Point `SNESTACK_BRAIN_ROOT` at wherever your Drive folder actually syncs to (e.g. `~/Google Drive/My Drive/personal-brain`) and the db, brain, and reports all follow.

A `fundamentals` table holds one cached row per `(ticker, as_of_date, source)` — `source` is `finnhub` or `morningstar`, kept as two independent rows rather than merged, since the two providers' figures aren't reconciled against each other. `quotes` has a `fetched_at` column alongside it. `data-refresh` (see "Skill harness" below) is the only thing that writes either table; everything else (`run-skill`, `data-dump`) only reads from them.

## Project Layout

```
node/
├── src/
│   ├── core/                    # domain-agnostic harness: db, config, setup, models,
│   │                            # errors, logger, skillLoader, domainRegistry,
│   │                            # executor, runSkill
│   ├── config/
│   │   └── domains.json         # registers each domain's skillsDir + contextToolsModule
│   ├── domains/
│   │   ├── financial/           # skills/, brain/ (external, see Database below), agents/,
│   │   │                        # tools/, providers/, contextTools.ts, dataRefresh.ts
│   │   │                        # (tiered ingestion), cliHelpers.ts (shared ticker resolution)
│   │   └── calendar/            # skills/, tools/, googleAuth.ts, setup.ts, contextTools.ts
│   └── cli.ts
└── tests/                       # Jest test suite (mirrors src/)
```

## Skill harness

`snestack run-skill <domain> <skill> <subject>` loads a skill markdown file's frontmatter (`name`/`domain`/`requires`/`references`), resolves its `requires` via that domain's `contextTools.ts`, and runs the assembled prompt through the model. This is the current, non-deprecated path — see `src/domains/financial/skills/INDEX.md` for the financial domain's skills, or `src/domains/calendar/skills/` for the calendar domain's.

```bash
snestack run-skill financial long-term-quality NVDA
snestack run-skill calendar daily-agenda today
```

For the financial domain, `run-skill`/`data-dump` never call Finnhub/Twelve Data/Morningstar themselves — they only read `snestack.db`'s cache (falling back to a live fetch, with a logged warning, only if the cache is missing or badly stale). `data-refresh --tier <intraday|daily|weekly>` is the one command that populates that cache:

```bash
snestack data-refresh --tier daily            # quote + RSI/MA + Finnhub fundamentals, all positions/watchlist
snestack data-refresh --tier intraday --tickers NVDA,TSLA   # live price only, scoped to two tickers
snestack data-refresh --tier weekly           # re-parse the current Morningstar PDF per ticker
```

### Calendar domain setup (Google Calendar, read-only)

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or reuse) a project, enable the **Google Calendar API**, then create an **OAuth client ID** of type **Desktop app** under Credentials.
2. Set `SNESTACK_GOOGLE_CLIENT_ID` and `SNESTACK_GOOGLE_CLIENT_SECRET` from that client in `.env`.
3. Run `snestack calendar auth` — it prints a consent URL, opens a local server to catch the redirect, and saves `SNESTACK_GOOGLE_REFRESH_TOKEN` to `.env` for you. Read-only scope (`calendar.readonly`) only — nothing is ever written to your calendar.

### Travel domain setup (Gmail, read-only)

Two ways to run `catalog-trip-year` — see `src/domains/travel/skills/catalog-trip-year.md` for the full tradeoff:

- **Manual** (higher fidelity, no setup beyond what's already here): `snestack travel prep-catalog <year>` assembles the skill + that year's Timeline clusters into one prompt; paste it into a Claude session with real Gmail + Google Maps access and do the search interactively.
- **Automated** (lower fidelity, runs unattended): requires its own Gmail OAuth consent, separate from the calendar domain's.
  1. In the same Google Cloud project as above, enable the **Gmail API** (Calendar and Gmail are separate APIs even on one project/OAuth client).
  2. Run `snestack travel auth` — same flow as `calendar auth`, but for the `gmail.readonly` scope, saved to `SNESTACK_GOOGLE_GMAIL_REFRESH_TOKEN` (a separate token, since the calendar one was never granted Gmail access).
  3. Run `snestack travel catalog <year>` (the nightly cron wrappers `scripts/travel-catalog-nightly.sh` and `scripts/travel-catalog-backfill.sh` are deprecated and unscheduled — API cost) — fetches Gmail + Timeline context deterministically, runs the skill in one model call, and writes to `<SNESTACK_BRAIN_ROOT>/travel/<year>/.nightly-draft/`. That's a staging directory, not the canonical files — review and move what's good into place yourself.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SNESTACK_FINNHUB_API_KEY` | Yes | Finnhub quote data |
| `SNESTACK_TWELVEDATA_API_KEY` | No | Historical closes for RSI/MA (Finnhub's free tier blocks `/stock/candle`) — falls back to Finnhub-only, no RSI/MA, if unset |
| `SNESTACK_CLAUDE_API_KEY` | Yes | Claude API (skill execution, signal distillation) |
| `SNESTACK_MODEL_CHEAP` / `_NORMAL` / `_EXPENSIVE` | No | Model behind each cost tier (defaults: `claude-haiku-4-5-20251001` / `claude-sonnet-5-5` / `claude-opus-5-5`). Skills select a tier with `model:` in frontmatter; default `normal`. |
| `SNESTACK_GMAIL_ADDRESS` | Yes | Gmail sender address |
| `SNESTACK_GMAIL_APP_PASSWORD` | Yes | Gmail app password |
| `SNESTACK_NOTIFICATION_EMAIL` | Yes | Where to send signals |
| `SNESTACK_BRAIN_ROOT` | No | Root of the shared folder (default: `~/Documents/personal-brain`) — db, brain, and reports paths all derive from this one setting |
| `SNESTACK_TWILIO_ACCOUNT_SID` | No | SMS via Twilio |
| `SNESTACK_TWILIO_AUTH_TOKEN` | No | SMS via Twilio |
| `SNESTACK_SMS_PHONE` | No | SMS recipient number |
| `SNESTACK_GOOGLE_CLIENT_ID` | No | Calendar domain — Google OAuth "Desktop app" client ID |
| `SNESTACK_GOOGLE_CLIENT_SECRET` | No | Calendar domain — Google OAuth client secret |
| `SNESTACK_GOOGLE_REFRESH_TOKEN` | No | Calendar domain — written by `snestack calendar auth`, not set by hand |
| `SNESTACK_GOOGLE_GMAIL_REFRESH_TOKEN` | No | Travel domain — written by `snestack travel auth`, not set by hand (separate token from the calendar one above; same `SNESTACK_GOOGLE_CLIENT_ID`/`_SECRET`, different scope) |
