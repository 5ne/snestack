# fstack — Python Implementation (Reference)

The original Python implementation of fstack. Kept as a reference alongside the active Node.js implementation.

## Prerequisites

- Python 3.9+
- pip

## Setup

```bash
cd python
pip install -e ".[dev]"
cp .env.example .env
# Edit .env with your API keys
```

## Running the CLI

```bash
# First-time setup
fstack setup

# Add positions / watchlist
fstack position add NVDA 100 850.00
fstack watchlist add TSLA "waiting for dip"

# Analyze
fstack analyze NVDA
fstack batch --dry-run
fstack batch

# View signal history
fstack signals

# Retry failed notifications
fstack retry
```

## Tests

```bash
cd python
pytest
pytest --cov=fstack
```

## Database

Points to `../fstack.db` (the shared root database) by default. Override via `FSTACK_DATABASE_PATH` in `.env`.

## Project Layout

```
python/
├── fstack/
│   ├── core/          # db, models, errors, logger
│   ├── agents/        # quote, strategy, equity, cfo, trader
│   ├── tools/         # morningstar PDF parser
│   ├── config.py
│   ├── cli.py
│   └── scheduler.py
├── conftest.py
├── test_agents.py
├── test_integration.py
├── test_morningstar_parser.py
├── requirements.txt
├── setup.py
└── pytest.ini
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
