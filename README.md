# snestack — Personal Decision-Support System

A "thin harness, fat skills" system: deterministic TypeScript code fetches data, markdown skill files hold the actual judgment, and a domain-agnostic core harness runs a named skill against a subject through Claude. The financial domain (investment recommendations across a portfolio/watchlist) is the original use case; a calendar domain (read-only Google Calendar) is the second, added specifically to prove the harness generalizes.

> **Early Alpha. Use at your own risk. Always conduct independent due diligence.**

## Structure

```
snestack/
└── node/              # Node.js / TypeScript implementation
    └── src/
        ├── core/       # domain-agnostic harness: skillLoader, domainRegistry,
        │               # executor, runSkill, db, config, logger, errors
        ├── config/
        │   └── domains.json   # registers each domain's skillsDir + contextTools
        └── domains/
            ├── financial/     # skills/, agents/, tools/, providers/
            └── calendar/      # skills/, tools/, googleAuth.ts, setup.ts
```

`snestack.db`, `brain/`, and `reports/` (Morningstar PDFs) all live outside the repo, in a shared Google Drive folder at `<SNESTACK_BRAIN_ROOT>/financial/` (default `~/Documents/personal-brain/financial/`) — not committed here; see `.gitignore`.

## Running a skill

```bash
snestack run-skill financial long-term-quality NVDA
snestack run-skill calendar daily-agenda today
```

`run-skill <domain> <skill> <subject>` loads the skill markdown's frontmatter (`requires`/`references`), resolves that domain's context tools, and runs the assembled prompt through Claude. See [`node/README.md`](node/README.md) for full setup (API keys, Google Calendar OAuth) and the CLI reference.

## Database

`snestack.db` (in `~/Documents/personal-brain/financial/` by default) is the financial domain's single source of truth: positions, watchlist, historical quotes/technicals, signal history, and the pending-notification queue. Its path is derived from `SNESTACK_BRAIN_ROOT` in `.env` — see [`node/README.md`](node/README.md)'s Environment Variables table.

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
