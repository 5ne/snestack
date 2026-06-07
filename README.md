# fstack — Personal Investment Decision-Support System

An AI-powered system that synthesizes technical, fundamental, and qualitative signals to generate investment recommendations for your portfolio and watchlist. Powered by Claude API, Finnhub, and Morningstar research.

> **Early Alpha. Use at your own risk. Always conduct independent due diligence.**

## Structure

```
fstack/
├── fstack.db          # Shared SQLite database (positions, signals, quotes)
├── reports/           # Morningstar PDF research reports (shared)
├── node/              # Node.js / TypeScript implementation (active)
└── python/            # Python implementation (original reference)
```

Both implementations share the same SQLite database and Morningstar reports. They are functionally equivalent — the Node implementation is the active development target; Python is the original reference.

## Shared Database

`fstack.db` at the root is the single source of truth for:
- Positions and watchlist
- Historical quotes and technical indicators
- CFO signals and recommendations
- Pending notification queue

Both implementations point to `../fstack.db` by default when run from their respective directories.

## Morningstar Reports

Download research PDFs from Schwab and place them in `reports/`:

```
reports/
├── NVDA-morningstar.pdf
├── AAPL-morningstar.pdf
└── ...
```

Both implementations look for reports in `../reports/` by default.

## Implementations

### Node (active)
TypeScript, node:sqlite, Claude SDK, Finnhub, nodemailer. See [`node/README.md`](node/README.md).

### Python (reference)
Python 3.9+, SQLite, Anthropic SDK, Finnhub. See [`python/README.md`](python/README.md).

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
              fstack.db (signal history)
```

## Roadmap

- [ ] Next.js web UI (Node implementation as backend)
- [ ] Supabase migration (multi-user support)
- [ ] Broker integrations (Schwab, Alpaca)
- [ ] Extended technical indicators (MACD, Bollinger Bands)
- [ ] Backtesting framework

## Disclaimer

For educational purposes only. Past performance does not predict future results. The author is not responsible for investment losses.
