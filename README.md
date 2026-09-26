# snestack — Personal Decision-Support System

A "thin harness, fat skills" system: deterministic TypeScript code fetches data, markdown skill files hold the actual judgment, and a domain-agnostic core harness runs a named skill against a subject through Claude. The financial domain (investment recommendations across a portfolio/watchlist) is the original use case; a calendar domain (read-only Google Calendar) is the second, added specifically to prove the harness generalizes.

> **Early Alpha. Use at your own risk. Always conduct independent due diligence.**

## Structure

```
snestack/
├── reports/           # Morningstar PDF research reports (financial domain)
└── node/              # Node.js / TypeScript implementation
    └── src/
        ├── core/       # domain-agnostic harness: skillLoader, domainRegistry,
        │               # executor, runSkill, db, config, scheduler, logger, errors
        ├── config/
        │   └── domains.json   # registers each domain's skillsDir + contextTools
        └── domains/
            ├── financial/     # skills/, agents/, tools/, providers/, orchestrator.ts
            └── calendar/      # skills/, tools/, googleAuth.ts, setup.ts
```

`snestack.db` and `brain/` live outside the repo, in the shared Google Drive folder at `~/Documents/personal-brain/` — not committed here; see `.gitignore`.

## Running a skill

```bash
snestack run-skill financial long-term-quality NVDA
snestack run-skill calendar daily-agenda today
```

`run-skill <domain> <skill> <subject>` loads the skill markdown's frontmatter (`requires`/`references`), resolves that domain's context tools, and runs the assembled prompt through Claude. See [`node/README.md`](node/README.md) for full setup (API keys, Google Calendar OAuth) and the CLI reference.

## Database

`snestack.db` (in `~/Documents/personal-brain/financial/`) is the financial domain's single source of truth: positions, watchlist, historical quotes/technicals, signal history, and the pending-notification queue. The CLI reads its location from `SNESTACK_DATABASE_PATH` in `.env`.

## Morningstar Reports

Download research PDFs from Schwab and place them in `reports/`:

```
reports/
├── NVDA-morningstar.pdf
├── AAPL-morningstar.pdf
└── ...
```

## Legacy pipeline

The financial domain also has an older, deprecated `analyze`/`batch` CLI path (`CfoAgent`/`AnalysisOrchestrator`) that hardcodes its judgment directly in TypeScript instead of going through the skills system. It still runs — kept for reference — but prints a deprecation warning; `run-skill` is the current path:

```
Positions + Watchlist
        ↓
[QuoteAgent] [StrategyAgent] [EquityAgent]   ← parallel, deterministic
        ↓           ↓              ↓
              signals combined
                    ↓
    [CfoAgent — deprecated]  ← hardcoded judgment, one Claude call for all tickers
                    ↓
            BUY / SELL / HOLD signals
                    ↓
            [TraderAgent] → email/SMS
                    ↓
              snestack.db (signal history)
```

## Roadmap

**Harness** (applies across every domain):
- [ ] More domains — any recurring "fetch some data, apply my own judgment" pattern is a candidate, not just investing or calendars
- [ ] Non-linear orchestration — a router step or graph/event model instead of the current fixed per-skill call, once enough skills exist per domain to make that worth building
- [ ] A structured signal/outcome log per domain (what was decided, what happened) as training data for future tuning

**Financial domain:**
- [ ] Retire the legacy `analyze`/`batch` pipeline once skill markdown fully covers what `CfoAgent` still does
- [ ] Provider adapters for a second fundamentals source (a Morningstar API subscription, behind the existing `FundamentalsProvider` interface)
- [ ] Backtesting / genetic-programming threshold tuning, offline, reading the same skill/brain markdown — never running live in the harness (see `CLAUDE.md`)
- [ ] Next.js web UI, Supabase migration, broker integrations (Schwab, Alpaca)

## Disclaimer

The financial domain is for educational purposes only. Past performance does not predict future results. The author is not responsible for investment losses.
