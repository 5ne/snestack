# snestack — Personal Decision-Support System

A "thin harness, fat skills" system: deterministic TypeScript code fetches data, markdown skill files hold the actual judgment, and a domain-agnostic core harness runs a named skill against a subject through Claude. The financial domain (investment recommendations across a portfolio/watchlist) is the original use case; a calendar domain (read-only Google Calendar) is the second, added specifically to prove the harness generalizes.

> **Early Alpha. Use at your own risk. Always conduct independent due diligence.**

## Structure

```
snestack/
├── node/              # Node.js / TypeScript CLI, harness, and HTTP JSON API
│   └── src/
│       ├── core/       # domain-agnostic harness: skillLoader, domainRegistry,
│       │               # executor, runSkill, db, config, logger, errors, api/
│       ├── config/
│       │   └── domains.json   # registers each domain's skillsDir + contextTools + apiModule
│       └── domains/
│           ├── financial/     # skills/, agents/, tools/, providers/, api.ts
│           ├── calendar/      # skills/, tools/, googleAuth.ts, setup.ts, api.ts
│           └── travel/        # skills/, tools/, googleAuth.ts, setup.ts, api.ts
└── web/               # Isomorphic Web UI (Vite + React 19 + Unison light-dark theme)
```

## Web UI & Isomorphic Server

`snestack` is isomorphic across CLI and Web UI — both talk to the exact same core and domain API routes (`snestack routes` / `GET /api/routes`):

```bash
cd web && npm install && npm run build
cd ../node && npm run serve
# Open http://127.0.0.1:4700
```

To run `snestack serve` persistently on macOS (`launchd` LaunchAgent on `127.0.0.1:4700`, with optional private Tailscale HTTPS access across your devices while keeping `<brain>` on your local Mac):

```bash
cd node
npm run service:install      # builds web/ + node/, loads ~/Library/LaunchAgents/com.snestack.server.plist
npm run service:status       # verifies LaunchAgent + /api/health
npm run service:tailscale    # optional: tailscale serve --bg 4700 (private tailnet HTTPS)
```

`brain/` and `reports/` (Morningstar PDFs) live outside the repo, in a shared Google Drive folder at `<SNESTACK_BRAIN_ROOT>/financial/` (default `~/Documents/personal-brain/financial/`) — not committed here; see `.gitignore`.

## Running a skill

```bash
snestack run-skill financial long-term-quality NVDA
snestack run-skill calendar daily-agenda today
```

`run-skill <domain> <skill> <subject>` loads the skill markdown's frontmatter (`requires`/`references`), resolves that domain's context tools, and runs the assembled prompt through Claude. See [`node/README.md`](node/README.md) for full setup (API keys, Google Calendar OAuth) and the CLI reference.

## Database

The financial domain's single source of truth — positions, watchlist, historical quotes/technicals, fundamentals, and signal history — is a hosted Postgres (Supabase) reached via `SNESTACK_DATABASE_URL` in `node/.env`. See [`node/README.md`](node/README.md)'s Database section.

## Morningstar Reports

Research PDFs from Schwab live in `~/Documents/personal-brain/financial/reports/`, not in this repo:

```
~/Documents/personal-brain/financial/reports/
├── NVDA-morningstar.pdf
├── AAPL-morningstar.pdf
└── ...
```

Download a PDF into `reports/staging/` and run `snestack organize-reports` to file it — see that folder's own README for details.

## Roadmap

**Harness** (applies across every domain):
- [ ] More domains — any recurring "fetch some data, apply my own judgment" pattern is a candidate, not just investing or calendars
- [ ] Non-linear orchestration — a router step or graph/event model instead of the current fixed per-skill call, once enough skills exist per domain to make that worth building
- [ ] A structured signal/outcome log per domain (what was decided, what happened) as training data for future tuning

**Financial domain:**
- [ ] Provider adapters for a second fundamentals source (a Morningstar API subscription, behind the existing `FundamentalsProvider` interface)
- [ ] Backtesting / genetic-programming threshold tuning, offline, reading the same skill/brain markdown — never running live in the harness (see `CLAUDE.md`)
- [ ] Next.js web UI, Supabase migration, broker integrations (Schwab, Alpaca)

## Disclaimer

The financial domain is for educational purposes only. Past performance does not predict future results. The author is not responsible for investment losses.
