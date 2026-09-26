# snestack Test Suite

Test coverage for the snestack investment orchestration system.

## Running Tests

### Run all tests (excluding optional)
```bash
pytest tests/
```

### Run only optional edge-case tests
```bash
pytest tests/test_edge_cases.py -m optional
```

### Run specific gap test
```bash
pytest tests/test_edge_cases.py::TestQuoteAgentTimeout -m optional
```

### Skip optional tests
```bash
pytest tests/ -m "not optional"
```

### Run with verbose output
```bash
pytest tests/ -v
```

### Run with short traceback
```bash
pytest tests/ --tb=short
```

## Test Organization

### test_edge_cases.py
Covers the 7 identified gaps in test coverage:

1. **Gap 1: QuoteAgent timeout** (`TestQuoteAgentTimeout`)
   - Single ticker timeout handling
   - Batch analysis continues after timeout
   - Tests: `test_quote_agent_timeout_single_ticker`, `test_quote_agent_timeout_batch_continues`

2. **Gap 2: StrategyAgent no match** (`TestStrategyAgentNoMatch`)
   - No rules match → confidence 0
   - Conflicting rules handling
   - Tests: `test_strategy_agent_no_rules_match`, `test_strategy_agent_multiple_conflicting_rules`

3. **Gap 3: EquityAgent red flags** (`TestEquityAgentRedFlags`)
   - Debt ratio detection
   - Red flag flagging for Claude
   - Tests: `test_equity_agent_detects_red_flag_debt`

4. **Gap 4: Claude refusal** (`TestCFOAgentRefusal`)
   - Claude refuses recommendation → HOLD default
   - Rate limit handling
   - Tests: `test_cfo_agent_claude_refusal_defaults_to_hold`, `test_cfo_agent_handles_rate_limit`

5. **Gap 5: Email send failure** (`TestEmailSendFailure`)
   - SMTP error → pending queue
   - Retry pending emails on next run
   - Tests: `test_trader_email_send_fails_queued`, `test_trader_retry_pending_emails`

6. **Gap 6: Invalid key validation** (`TestInvalidKeyValidation`)
   - Invalid API key detected
   - Setup validates and retries with guidance
   - Tests: `test_invalid_api_key_detected`, `test_setup_validates_api_keys`

7. **Gap 7: Concurrent analysis** (`TestConcurrentAnalysisRaceCondition`)
   - Same ticker concurrent analysis serializes
   - Different tickers run in parallel
   - DB writes serialize correctly
   - Tests: `test_concurrent_analysis_same_ticker`, `test_concurrent_analysis_different_tickers`, `test_concurrent_db_writes_serialize`

## Why Optional Tests?

These edge-case tests can be flaky due to:
- Timing dependencies (timeouts, concurrency)
- External service mocking complexity
- Race conditions that are hard to reproduce consistently

By marking them as `@pytest.mark.optional`, you can:
1. Include them in CI/CD but allow failures
2. Skip them locally during rapid iteration
3. Run them separately before releases
4. Track their pass/fail rate without blocking builds

## Test Fixtures

- `test_db`: Provides a fresh SQLite test database with full schema

## Markers

- `@pytest.mark.optional` - Tests that can be skipped if flaky
- `@pytest.mark.unit` - Unit tests with no external dependencies
- `@pytest.mark.integration` - Integration tests with other components
- `@pytest.mark.slow` - Tests that take > 1 second
- `@pytest.mark.async` - Async/await tests

## Best Practices

1. Use `pytest.mark.optional` for tests that depend on timing/concurrency
2. Use `AsyncMock` for async function mocking
3. Use `test_db` fixture for database tests
4. Mock external services (API calls, SMTP)
5. Use descriptive test names that explain the scenario
6. Add docstrings explaining what's being tested and why
