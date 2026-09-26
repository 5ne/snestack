# fstack — Personal Investment Decision-Support System

An AI-powered system that synthesizes technical, fundamental, and qualitative signals to generate investment recommendations for your portfolio and watchlist. Powered by Claude API, Finnhub, and Morningstar research.

> **Early Alpha. Use at your own risk. Always conduct independent due diligence.**

## Structure

```
fstack/
├── reports/           # Morningstar PDF research reports
└── node/              # Node.js / TypeScript implementation
```

`fstack.db` and `brain/` live outside the repo, in the shared Google Drive folder at `~/Documents/personal-brain/financial/` — they're not committed here; see `.gitignore`.

## Database

`fstack.db` (in `~/Documents/personal-brain/financial/`) is the single source of truth for:
- Positions and watchlist
- Historical quotes and technical indicators
- CFO signals and recommendations
- Pending notification queue

The CLI reads its location from `FSTACK_DATABASE_PATH` in `.env`.

## Morningstar Reports

Download research PDFs from Schwab and place them in `reports/`:

```
reports/
├── NVDA-morningstar.pdf
├── AAPL-morningstar.pdf
└── ...
```

## Implementation

TypeScript, node:sqlite, Claude SDK, Finnhub, nodemailer. See [`node/README.md`](node/README.md) for setup, CLI commands, and environment variables.

## Architecture

All analysis flows through the same multi-agent pipeline:

```
Positions + Watchlist
        ↓
[QuoteAgent] [StrategyAgent] [EquityAgent]   ← parallel
        ↓           ↓              ↓
              signals combined
                    ↓
              [CFOAgent]  ← one Claude API call for all tickers (~$0.02/run)
                    ↓
            BUY / SELL / HOLD signals
                    ↓
            [TraderAgent] → email/SMS
                    ↓
              fstack.db (signal history, in ~/Documents/personal-brain/financial/)
```

## Roadmap

- [ ] Next.js web UI
- [ ] Supabase migration (multi-user support)
- [ ] Broker integrations (Schwab, Alpaca)
- [ ] Extended technical indicators (MACD, Bollinger Bands)
- [ ] Backtesting framework

## Disclaimer

For educational purposes only. Past performance does not predict future results. The author is not responsible for investment losses.
