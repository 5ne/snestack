# Contributing to fstack

Thank you for your interest in contributing! This guide explains how to set up your development environment and contribute code.

## Development Setup

### Prerequisites
- Python 3.9+
- pip
- git
- crontab (for scheduler testing)

### Install for Development

```bash
git clone https://github.com/yourusername/fstack.git
cd fstack

# Install with dev dependencies
pip install -e ".[dev]"

# Install pre-commit hooks (optional)
pre-commit install
```

### Run Tests

```bash
# Run all tests
pytest tests/ -v

# Run with coverage
pytest tests/ --cov=fstack --cov-report=html

# Run only integration tests
pytest tests/test_integration.py -v

# Run only edge-case tests
pytest tests/test_edge_cases.py -m optional -v

# Run specific test
pytest tests/test_integration.py::TestDatabase::test_add_position -v
```

### Code Quality

```bash
# Format code
black fstack/ tests/

# Lint
ruff check fstack/ tests/ --fix

# Type check
mypy fstack/ tests/

# All together
black fstack/ tests/ && ruff check fstack/ tests/ --fix && mypy fstack/ tests/
```

## Architecture Overview

fstack follows a multi-agent architecture:

```
User Input (CLI)
    ↓
[Config] + [Database]
    ↓
Agents:
  - QuoteAgent: Finnhub API → OHLCV + indicators
  - StrategyAgent: Rules engine → BUY/SELL/HOLD signals
  - EquityAgent: Fundamentals API → PE, FCF, red flags
  - CFOAgent: Claude → final synthesis
  - TraderAgent: Email/SMS → send notifications
    ↓
[Database] → storage
    ↓
User: Email notification
```

## Key Files

```
fstack/
├── cli.py              ← Main entry point
├── config.py           ← Environment config + key validation
├── scheduler.py        ← Cron setup
├── core/
│   ├── db.py          ← SQLite schema + queries
│   ├── models.py      ← Pydantic data classes
│   ├── setup.py       ← Interactive setup
│   ├── analysis.py    ← Orchestration logic
│   ├── logger.py      ← Structured logging
│   └── errors.py      ← Custom exceptions
└── agents/
    ├── base.py        ← BaseAgent + retry logic
    ├── quote_agent.py
    ├── strategy_agent.py
    ├── equity_agent.py
    ├── cfo_agent.py
    └── trader_agent.py
```

## Adding a New Agent

1. Create `fstack/agents/my_agent.py`
2. Inherit from `BaseAgent` or `ThrottledAPIAgent`
3. Implement `async def analyze(ticker: str, **kwargs) -> Optional[Result]`
4. Add retry decorator if needed: `@retry_async(max_attempts=3)`
5. Add to `fstack/agents/__init__.py`
6. Write tests in `tests/test_agents.py`

Example:

```python
from fstack.agents.base import BaseAgent

class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__(name="MyAgent")

    async def analyze(self, ticker: str, **kwargs) -> Optional[dict]:
        try:
            result = await self._fetch_data(ticker)
            return result
        except Exception as e:
            self.logger.error(f"Analysis failed: {e}")
            return None

    async def _fetch_data(self, ticker: str) -> dict:
        # Your logic here
        pass
```

## Adding a New CLI Command

1. Add subparser in `cli.py`:
```python
my_parser = subparsers.add_parser("mycommand", help="Description")
my_parser.add_argument("--option", help="Option help")
```

2. Add command handler:
```python
def cmd_mycommand(args) -> int:
    try:
        # Your logic
        return 0
    except Exception as e:
        logger.error(f"Command failed: {e}")
        return 1
```

3. Add to main dispatcher:
```python
elif args.command == "mycommand":
    return cmd_mycommand(args)
```

## Testing Guidelines

- Write tests for new agents (unit tests in `tests/test_agents.py`)
- Write integration tests for new CLI commands
- Mark flaky tests with `@pytest.mark.optional`
- Use `test_db` fixture for database tests
- Mock external APIs (Finnhub, Claude, Gmail)

## Commit Message Format

Follow conventional commits:

```
feat: add X feature
fix: fix Y bug
docs: update README
test: add tests for X
refactor: refactor Y module
chore: update dependencies
```

Example:

```
feat: add EquityAgent red flag detection

- Detect high debt/equity ratios
- Detect negative FCF
- Flag declining earnings/revenue
- Tests in test_agents.py

Co-Authored-By: Your Name <your.email@example.com>
```

## Reporting Issues

Before opening an issue, check:

1. Is this a duplicate? Search existing issues
2. Can you reproduce it? Include steps
3. What's your environment? Python version, OS
4. What do you expect? vs. What actually happened?

## Proposing Features

1. Open an issue describing the feature
2. Discuss approach before coding
3. Implementation follows architecture guidelines
4. Include tests
5. Update docs
6. Submit PR with reference to issue

## Code Review

All PRs require review before merge. We look for:

- ✓ Tests pass
- ✓ Code formatted (black/ruff/mypy)
- ✓ Follows architecture patterns
- ✓ Docstrings on public APIs
- ✓ No breaking changes (or major version bump)
- ✓ Docs updated if needed

## Questions?

- Open a GitHub discussion
- Check existing issues
- Read the README and docs

Thank you for contributing!
