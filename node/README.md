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

# Full nightly long-term-quality pipeline (data-dump -> gated run-skill long-term-quality
# per ticker -> build-signals -> notify/notify-summary).
./scripts/daily-analysis.sh
```

Five cron jobs together make up the split-cadence pipeline (`npm run build` first against each — all five scripts run the built CLI, not `npm run dev`). The market trades on US/Eastern hours regardless of where the cron daemon runs, so the times below are given as Pacific-time wall-clock values, converted to still land within 9:30am-4pm ET market hours — **cron interprets its time fields in the machine's own local timezone** (macOS's built-in cron has no `CRON_TZ` support; check `/etc/localtime` to confirm yours), so adjust the hour numbers below if your machine isn't on Pacific time:

| Script | Cadence (Pacific) | What it does |
| --- | --- | --- |
| `scripts/data-refresh-intraday.sh` | every 30 min, 6:30am-1pm PT (market hours) | Live quote price only (skips fundamentals) |
| `scripts/data-refresh-daily.sh` | 2pm PT, nightly | Quote + RSI/MA + Finnhub fundamentals; Morningstar re-parse on Mondays only |
| `scripts/daily-analysis.sh` | 2:30pm PT, nightly, after `data-refresh-daily.sh` | `long-term-quality` skill for every ticker, email + signal history |
| `scripts/swing-check.sh` | hourly, 7am-1pm PT (market hours) | `swing-trading-large-cap` skill for every ticker, its own email + signal history |
| `scripts/reflect-check.sh` | 11pm PT, nightly, well after market hours | `improve-self` skill per registered domain (gated), writes/emails new feature-request proposals |

```cron
# crontab -e  (adjust the <repo> path; times are Pacific/local as described above)
*/30 6-13 * * 1-5 cd <repo>/node && ./scripts/data-refresh-intraday.sh >> logs/data-refresh-intraday.cron.log 2>&1
0 14 * * 1-5 cd <repo>/node && ./scripts/data-refresh-daily.sh >> logs/data-refresh-daily.cron.log 2>&1
30 14 * * 1-5 cd <repo>/node && ./scripts/daily-analysis.sh >> logs/daily-analysis.cron.log 2>&1
0 7-13 * * 1-5 cd <repo>/node && ./scripts/swing-check.sh >> logs/swing-check.cron.log 2>&1
0 23 * * 1-5 cd <repo>/node && ./scripts/reflect-check.sh >> logs/reflect-check.cron.log 2>&1
```

Each script supports `--dry-run` (runs everything but emails/records nothing, output goes to a `-dryrun` directory) and `--tickers A,B,C` (overrides the positions+watchlist default; `reflect-check.sh` has no tickers, just `--dry-run`). `snestack run-check` summarizes recent runs across the first four — see `node/src/core/runCheck.ts`; it doesn't yet have an expectation for `reflect-check.sh` itself (a reasonable follow-up, not required for the initial build).

**What each job actually does:**

- **`data-refresh-intraday.sh`** — one step: `data-refresh --tier intraday` for every position/watchlist ticker. Refreshes live quote price only; Finnhub fundamentals are skipped entirely (that's the daily tier's job), and RSI/50MA/200MA are left alone too — they're gated to update at most once a day inside `data-refresh`, so running this every 30 min mostly just keeps the live price current. Writes its own timestamped run directory under `<brain>/financial/runs/intraday/<date>/<time>/`, since it fires multiple times a day.
- **`data-refresh-daily.sh`** — two steps: `data-refresh --tier daily` (quote + RSI/MA + Finnhub live fundamentals for every ticker), then `data-refresh --tier weekly` (re-parses whatever Morningstar PDF currently sits in `reports/`) — but only on Mondays, since re-parsing the same on-disk PDF every night would be pure waste. This is what's expected to populate the cache before `daily-analysis.sh` runs. One run directory per day under `<brain>/financial/runs/data-refresh-daily/<date>/`.
- **`daily-analysis.sh`** — four steps: (1) `data-dump` to snapshot the cache (populated by `data-refresh-daily.sh` earlier) and get the ticker list; (2) run the `long-term-quality` skill against every ticker with `--gated --out`, one Claude call each *if* the skill's own `gate:` triggers fire (RSI, price-move, age, or a changed Morningstar/brain file — see `core/gate.ts`), writing `<ticker>-long-term-quality.md`; (3) `build-signals` to read each write-up's trailing `VERDICT:` line into one structured signals array, deterministically, no model call; (4) `notify` to email that batch and record it in `snestack.db`'s `signals` table — or, if every call was gated off (nothing worth a fresh look happened), `notify-summary` instead, emailing a "no changes today" heartbeat rather than staying silent. No longer touches `swing-trading-large-cap` — that moved to its own script. Output lands in `<brain>/financial/signals/<date>/`.
- **`swing-check.sh`** — the same four-step shape as `daily-analysis.sh`, but for `swing-trading-large-cap` only, and run several times a day instead of once overnight: (1) `data-dump` for the ticker list, (2) the skill per ticker (also gated — RSI outside 30-70 is "no action" and skips the call), (3) `build-signals`, (4) `notify` if there's something to report. Unlike `daily-analysis.sh`, a quiet run here does **not** email a summary — several "nothing happened" emails a day would defeat the point of gating — it's just recorded in `run.json` for `run-check` to see. Each run gets its own timestamped directory under `<brain>/financial/runs/swing-check/<date>/<time>/`, so distill/notify are automatically scoped to that run's own tickers.
- **`reflect-check.sh`** — two steps, and the only one of the five that isn't financial-specific: (1) `reflect --json`, which runs every domain registered in `config/domains.json` through its own `improve-self` skill (gated — a quiet day for a domain costs no model call, just digest assembly) and writes any resulting proposals under `<brain>/<domain>/feature-requests/`; (2) `reflect-notify`, which emails one combined summary — each new proposal's domain, title, impact/effort, and its `snestack feature approve <id>` command — if anything new landed anywhere, and sends nothing on a quiet run. This system never edits its own source code, skills, or config; it only ever writes new proposal files (see `core/featureRequests.ts`), and turning a proposal into actual work stays a separate, deliberate, human-initiated step (`snestack feature approve <id>`, then pointing a normal session at the file). Spans every domain, not just financial, so its run record is staged under `<brain>/_system/runs/reflect/<date>/` rather than `<brain>/financial/...` like the other four.

All five record step-by-step outcomes to `run.jsonl`/`run.json` (see `core/runLog.ts`, staged locally under `~/Library/Logs/snestack/runs/` and published to the paths above when each run finishes), which `snestack run-check` reads (for the first four) to flag missing/failed/degraded runs and stale cached data.

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
│   │                            # executor, runSkill, reflect, featureRequests,
│   │                            # reflectNotify, email, runCheck, runLog
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

### Reflection: improve-self

`snestack reflect [--domain <d>] [--force] [--json]` is a harness-level job, not a financial one: it loops every domain registered in `config/domains.json` (or just the one named with `--domain`) and, for each one that has an `improve-self.md` skill (financial only, for now — see `src/domains/financial/skills/improve-self.md`), checks the skill's own `gate:` first (same `--gated` machinery as `run-skill`) and runs it if due. The skill reads a `reflectionDigest` of recent `run-check` findings, recent run summaries, and every existing feature-request proposal (so it doesn't duplicate one), and writes its judgment as zero or more `## Feature Request: <title>` sections. `core/featureRequests.ts` parses those deterministically and writes each as its own file under `<brain>/<domain>/feature-requests/<date>-<slug>.md`, skipping (and reporting) anything that looks like a near-duplicate of an existing `proposed`/`in-progress` proposal.

**The hard safety line:** this never edits source code, skills, or config — it only ever writes new files under `feature-requests/`. Turning a proposal into actual work is a separate, deliberate, human-initiated step.

```bash
snestack reflect                        # every registered domain with an improve-self skill
snestack reflect --domain financial     # just financial
snestack reflect --domain financial --force   # bypass the gate, run it right now regardless of last-run/inputs
snestack feature list                   # every proposal, any domain/status
snestack feature list --domain financial --status proposed
snestack feature approve 2026-10-13-add-retry-backoff-to-data-refresh   # proposed -> in-progress
snestack feature done 2026-10-13-add-retry-backoff-to-data-refresh      # -> done
```

`snestack reflect --json` prints a per-domain summary (ran/skipped, files written, duplicates skipped, parse errors) that `snestack reflect-notify --file <that json>` turns into one combined email — each new proposal with its `feature approve` command — sending nothing when there's nothing new. `scripts/reflect-check.sh --force` (cron table above) chains the two, forced; `reflect-check.sh` alone respects the gate as usual.

`--force` skips the gate check but not the "does this domain have an `improve-self.md` skill" check — it still reports `skipped (no improve-self skill for this domain yet)` for calendar/travel until those are built. A quiet result (zero proposals) right after a forced run is expected and fine — it means the skill looked and genuinely found nothing worth proposing, not that the force didn't work; check the model's own write-up (`snestack run-skill financial improve-self financial`, no gate at all) if you want to see its reasoning directly.

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
