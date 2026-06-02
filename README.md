# fstack — Personal Investment Decision-Support System

An AI-powered system that synthesizes technical, fundamental, and qualitative signals to generate investment recommendations for your portfolio and watchlist. Powered by Claude API, Finnhub, and Morningstar research.

**Note: Early Alpha. Use at your own risk. Always conduct independent due diligence.**

## Features

- **Multi-agent analysis**: 
  - **QuoteAgent**: Real-time OHLCV + technical indicators (RSI, moving averages)
  - **StrategyAgent**: Rules-based technical signals (oversold/overbought, crossovers, volume)
  - **EquityAgent**: Fundamental metrics from Morningstar (P/E, debt/equity, FCF, growth, red flags)
  - **CFOAgent**: Claude synthesizes all signals into unified BUY/SELL/HOLD recommendations
  
- **Morningstar integration**: Download research PDFs from Schwab, extract fair value estimates and qualitative insights
- **Batched Claude calls**: Analyze 20+ tickers in one API call (~$0.02/run)
- **Cross-machine sync**: Git LFS syncs Morningstar reports across all your development machines
- **Proactive notifications**: Daily batch analysis via cron, email or SMS
- **Interactive CLI**: Single-ticker analysis on-demand
- **Portfolio tracking**: Manage positions and watchlist items
- **Signal history**: SQLite storage of all signals for backtesting and analysis

## Installation

### Prerequisites

- Python 3.9+
- git
- git-lfs (for syncing Morningstar reports)

### Install fstack

```bash
git clone https://github.com/yourusername/fstack.git
cd fstack

# Install git-lfs (needed for Morningstar PDFs)
brew install git-lfs  # macOS
# apt-get install git-lfs  # Linux
git lfs install

# Install fstack with dev dependencies
pip install -e ".[dev]"

# Or just the base dependencies
pip install -e .
```

## Quick Start

### 1. Setup (interactive)

```bash
fstack setup
```

You'll be prompted for:
- **Finnhub API key** (quote data)
- **Claude API key** (synthesis)
- **Gmail address + app password** (notifications)
- **Notification email** (where to send signals)
- **Twilio credentials** (optional, for SMS)

Configuration saved to `.env`.

### 2. Add investments

```bash
# Add position
fstack position add NVDA 100 850.0

# Add watchlist item
fstack watchlist add TSLA "waiting for dip below $200"

# List
fstack position list
fstack watchlist list
```

### 3. Add Morningstar research (optional but recommended)

Download research PDFs from Schwab and add them to the reports folder:

```bash
# 1. Log into Schwab → Research → Search ticker
# 2. Download Morningstar PDF
# 3. Save to fstack/reports/{TICKER}-morningstar.pdf

# Example:
# fstack/reports/NVDA-morningstar.pdf
# fstack/reports/TSLA-morningstar.pdf

# Commit reports (synced via Git LFS)
git add fstack/reports/*.pdf
git commit -m "data: add Morningstar reports for NVDA, TSLA"
git push
```

See `fstack/reports/README.md` for details.

### 4. Run analysis

```bash
# Batch analysis (all positions + watchlist)
fstack batch

# Single ticker
fstack analyze NVDA

# Retry failed emails
fstack retry

# Dry run (don't send email)
fstack batch --dry-run
```

## Architecture

### Agents

- **QuoteAgent**: Fetches OHLCV from Finnhub, calculates RSI/MA-50/MA-200
- **StrategyAgent**: Rules-based technical signals (oversold, crossovers, volume)
- **EquityAgent**: Fundamentals (PE, debt/equity, FCF, growth), red flag detection
- **CFOAgent**: Claude synthesizes all signals into per-ticker BUY/SELL/HOLD
- **TraderAgent**: Batch email + pending retry queue

### Data Flow

```
Positions + Watchlist
    ↓
[Quote Agent] [Strategy Agent] [Equity Agent]  ← parallel async
    ↓              ↓                  ↓
            All signals combined
                    ↓
            [CFO Agent] ← one Claude call
                    ↓
              Per-ticker signals
                    ↓
          [Trader Agent] → email
                    ↓
            SQLite storage
```

### Database

```
tickers           → Master list (PUBLIC/PRIVATE)
positions         → Current portfolio holdings
watchlist         → Stocks under consideration
quotes            → Historical OHLCV + technical indicators
signals           → CFO recommendations with confidence and reasoning
pending_notifications → Failed emails queued for retry
```

## How Signals Work

Each signal represents fstack's synthesis of multiple factors:

### Technical Signals (StrategyAgent)
- **RSI**: Oversold (<30) = BUY, overbought (>70) = SELL
- **Moving Averages**: Golden cross (50MA > 200MA) = bullish, death cross = bearish
- **Volume**: High volume increases confidence in the signal

### Fundamental Signals (EquityAgent)
- **Valuation**: P/E, P/B, price-to-fair-value from Morningstar
- **Quality**: FCF yield, debt/equity, earnings/revenue growth
- **Red Flags**: Declining fundamentals, high leverage, shrinking margins

### Final Recommendation (CFOAgent)
Claude synthesizes all signals:
```
Recommendation: BUY | SELL | HOLD
Confidence: 0-100%
Reasoning: Plain-English explanation of the decision
```

**Interpretation:**
- **BUY (>70% confidence)**: Strong technical + fundamental case
- **SELL (>60% confidence)**: Overvalued or deteriorating technicals
- **HOLD**: Conflicting signals or insufficient data

Always combine fstack recommendations with your own research.

## Configuration

Set via `fstack setup` or edit `.env`:

```bash
FSTACK_FINNHUB_API_KEY=xxxxx
FSTACK_CLAUDE_API_KEY=sk-xxxxx
FSTACK_GMAIL_ADDRESS=you@gmail.com
FSTACK_GMAIL_APP_PASSWORD=xxxxx
FSTACK_NOTIFICATION_EMAIL=you@example.com
FSTACK_TWILIO_ACCOUNT_SID=ACxxxxx  # optional
FSTACK_TWILIO_AUTH_TOKEN=xxxxx     # optional
FSTACK_SMS_PHONE=+1234567890        # optional
```

## Scheduling (Cron)

Set up daily analysis at 6 AM:

```bash
0 6 * * * cd /path/to/fstack && /usr/bin/python -m fstack batch
```

For logs:

```bash
0 6 * * * cd /path/to/fstack && /usr/bin/python -m fstack batch >> fstack.log 2>&1
```

## Cost

- **Claude**: ~$0.015/batch run (batched CFO call) = $1-2/month for 2-4 runs/day
- **Finnhub**: Free tier (60 calls/min, sufficient for 20 tickers)
- **Gmail/Twilio**: Within their free tiers

## Development

### Run tests

```bash
pytest tests/

# With coverage
pytest tests/ --cov=fstack

# Optional edge-case tests only
pytest tests/test_edge_cases.py -m optional
```

### Format + lint

```bash
black fstack/
ruff check fstack/ --fix
mypy fstack/
```

## Limitations

- **Manual report downloads**: Morningstar reports must be manually downloaded from Schwab (automation pending Schwab API approval)
- **Private companies**: Tracked by name, not ticker. Company name normalization required.
- **Fundamentals API**: Currently sourced from Morningstar PDFs. Full API integration planned.
- **Technical indicators**: Limited to RSI and moving averages. Can be extended with MACD, Bollinger Bands, etc.
- **Notifications**: Email and SMS only. No in-app alerts yet.
- **No backtesting**: Signals are forward-looking; backtesting framework is in the roadmap.
- **No broker integration**: Recommendations must be acted on manually.

## Roadmap

### Near-term
- [ ] Schwab API integration for automated Morningstar report downloads
- [ ] Morningstar PDF parser (extract fair value, debt/equity, growth rates, red flags)
- [ ] Real-time Finnhub fundamentals fallback when reports unavailable
- [ ] Extended technical indicators (MACD, Bollinger Bands, volume profile)

### Medium-term
- [ ] Web dashboard for viewing signals and portfolio performance
- [ ] Backtesting framework with historical signal accuracy
- [ ] Custom rule engine for non-technical signals (news sentiment, insider trading, etc.)
- [ ] Slack/Discord notifications
- [ ] SQLite → PostgreSQL migration for team deployments

### Long-term
- [ ] Options/derivatives support (Greeks, IV analysis)
- [ ] Broker integrations (Schwab, Interactive Brokers, Alpaca)
- [ ] Mobile app
- [ ] ML-based signal refinement (training on historical signals + returns)

## License

MIT

## Disclaimer

This system is for educational purposes. Past performance ≠ future results. Always do your own research. The author is not responsible for investment losses.
