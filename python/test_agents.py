"""Unit tests for fstack agents — pure logic, no external API calls."""

import json
import pytest
import asyncio
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fstack.agents.quote_agent import QuoteAgent
from fstack.agents.strategy_agent import StrategyAgent
from fstack.agents.equity_agent import EquityAgent
from fstack.agents.cfo_agent import CFOAgent
from fstack.core.models import Signal, EquityData, QuoteData, StrategySignal


# ============================================================================
# QuoteAgent — RSI and moving average calculations
# ============================================================================

@pytest.mark.unit
class TestQuoteAgentCalculations:

    def test_rsi_oversold(self):
        # 14 down days followed by 1 up day → very low RSI
        prices = [100 - i for i in range(15)]
        rsi = QuoteAgent._calculate_rsi(prices)
        assert rsi is not None
        assert rsi < 35

    def test_rsi_overbought(self):
        # Prices rising every day → high RSI
        prices = [100 + i for i in range(15)]
        rsi = QuoteAgent._calculate_rsi(prices)
        assert rsi is not None
        assert rsi > 65

    def test_rsi_neutral(self):
        # Alternating up/down → near 50
        prices = [100 + (1 if i % 2 == 0 else -1) for i in range(15)]
        rsi = QuoteAgent._calculate_rsi(prices)
        assert rsi is not None
        assert 30 <= rsi <= 70

    def test_rsi_insufficient_data(self):
        assert QuoteAgent._calculate_rsi([]) is None
        assert QuoteAgent._calculate_rsi([100, 101, 102]) is None  # < period+1

    def test_rsi_no_losses(self):
        prices = [100 + i for i in range(20)]
        rsi = QuoteAgent._calculate_rsi(prices)
        assert rsi == 100.0

    def test_ma_correct_average(self):
        prices = list(range(1, 51))  # 1..50
        ma = QuoteAgent._calculate_moving_average(prices, period=50)
        assert ma == 25.5  # avg of 1..50

    def test_ma_insufficient_data(self):
        assert QuoteAgent._calculate_moving_average([100, 101], period=50) is None

    def test_ma_uses_last_n_prices(self):
        prices = [1] * 100 + [200] * 50  # 150 prices: first 100 are 1, last 50 are 200
        ma_50 = QuoteAgent._calculate_moving_average(prices, period=50)
        assert ma_50 == 200.0

    @pytest.mark.asyncio
    async def test_fetch_historical_returns_closes(self):
        agent = QuoteAgent(api_key="test")
        mock_hist = MagicMock()
        mock_hist.empty = False
        mock_hist.__getitem__ = MagicMock(return_value=MagicMock(
            dropna=MagicMock(return_value=MagicMock(tolist=MagicMock(return_value=[100.0, 101.0, 102.0])))
        ))
        with patch("yfinance.Ticker") as MockTicker:
            MockTicker.return_value.history.return_value = mock_hist
            result = await agent._fetch_historical("NVDA", days=30)
            assert result == [100.0, 101.0, 102.0]

    @pytest.mark.asyncio
    async def test_fetch_historical_empty_returns_none(self):
        agent = QuoteAgent(api_key="test")
        mock_hist = MagicMock()
        mock_hist.empty = True
        with patch("yfinance.Ticker") as MockTicker:
            MockTicker.return_value.history.return_value = mock_hist
            result = await agent._fetch_historical("FAKE", days=30)
            assert result is None


# ============================================================================
# StrategyAgent — signal logic
# ============================================================================

@pytest.mark.unit
class TestStrategyAgentSignals:

    def test_rsi_oversold_buy(self):
        rec, weight = StrategyAgent._rsi_signal(25.0, 100.0)
        assert rec == "BUY"
        assert weight == 0.8

    def test_rsi_overbought_sell(self):
        rec, weight = StrategyAgent._rsi_signal(75.0, 100.0)
        assert rec == "SELL"
        assert weight == 0.6

    def test_rsi_weak_buy(self):
        rec, weight = StrategyAgent._rsi_signal(35.0, 100.0)
        assert rec == "BUY"
        assert weight == 0.4

    def test_rsi_weak_sell(self):
        rec, weight = StrategyAgent._rsi_signal(65.0, 100.0)
        assert rec == "SELL"
        assert weight == 0.3

    def test_rsi_neutral(self):
        rec, weight = StrategyAgent._rsi_signal(50.0, 100.0)
        assert rec is None
        assert weight is None

    def test_ma_golden_cross_price_above(self):
        rec, weight = StrategyAgent._ma_signal(price=110, ma_50=105, ma_200=95)
        assert rec == "BUY"
        assert weight == 0.7

    def test_ma_golden_cross_price_below_50(self):
        rec, weight = StrategyAgent._ma_signal(price=98, ma_50=105, ma_200=95)
        assert rec == "BUY"
        assert weight == 0.5

    def test_ma_death_cross_price_below(self):
        rec, weight = StrategyAgent._ma_signal(price=85, ma_50=90, ma_200=100)
        assert rec == "SELL"
        assert weight == 0.7

    def test_ma_death_cross_price_above_50(self):
        rec, weight = StrategyAgent._ma_signal(price=95, ma_50=90, ma_200=100)
        assert rec == "SELL"
        assert weight == 0.5

    def test_ma_equal_averages(self):
        rec, weight = StrategyAgent._ma_signal(price=100, ma_50=100, ma_200=100)
        assert rec is None

    def test_weighted_consensus_buy(self):
        assert StrategyAgent._weighted_consensus(["BUY", "BUY"], [0.7, 0.8]) == "BUY"

    def test_weighted_consensus_sell(self):
        assert StrategyAgent._weighted_consensus(["SELL", "SELL"], [0.7, 0.6]) == "SELL"

    def test_weighted_consensus_hold_on_conflict(self):
        assert StrategyAgent._weighted_consensus(["BUY", "SELL"], [0.5, 0.5]) == "HOLD"

    def test_weighted_consensus_empty(self):
        assert StrategyAgent._weighted_consensus([], []) == "HOLD"

    def test_build_reasoning_includes_rsi(self):
        r = StrategyAgent._build_reasoning("NVDA", rsi=25.0, ma_50=200.0, ma_200=180.0, price=210.0)
        assert "RSI 25" in r
        assert "oversold" in r

    def test_build_reasoning_golden_cross(self):
        r = StrategyAgent._build_reasoning("NVDA", rsi=50.0, ma_50=205.0, ma_200=180.0, price=210.0)
        assert "Golden cross" in r

    def test_build_reasoning_death_cross(self):
        r = StrategyAgent._build_reasoning("NVDA", rsi=50.0, ma_50=175.0, ma_200=180.0, price=170.0)
        assert "Death cross" in r

    @pytest.mark.asyncio
    async def test_analyze_no_quote_returns_hold(self, db):
        db.add_ticker("FAKE", "Fake Corp", "PUBLIC")
        agent = StrategyAgent(db=db)
        signal = await agent.analyze("FAKE")
        assert signal.recommendation == "HOLD"
        assert signal.confidence == 0

    @pytest.mark.asyncio
    async def test_analyze_with_oversold_rsi(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        db.add_quote("NVDA", "2026-06-01", 200, 210, 195, 205, 1_000_000, rsi=25.0, ma_50=210.0, ma_200=190.0)
        agent = StrategyAgent(db=db)
        signal = await agent.analyze("NVDA")
        assert signal is not None
        assert signal.recommendation in ("BUY", "SELL", "HOLD")
        assert 0.0 <= signal.confidence <= 1.0

    @pytest.mark.asyncio
    async def test_analyze_neutral_rsi_no_ma_returns_hold(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        db.add_quote("NVDA", "2026-06-01", 200, 210, 195, 205, 1_000_000, rsi=50.0)
        agent = StrategyAgent(db=db)
        signal = await agent.analyze("NVDA")
        assert signal.recommendation == "HOLD"
        assert signal.confidence == 0


# ============================================================================
# EquityAgent — red flag detection
# ============================================================================

@pytest.mark.unit
class TestEquityAgentRedFlags:

    def test_no_red_flags_clean_company(self):
        flags = EquityAgent._detect_red_flags({
            "pe_ratio": 20.0, "debt_to_equity": 0.3,
            "fcf": 5e9, "fcf_yield": 0.03,
            "earnings_growth": 0.15, "revenue_growth": 0.12,
        })
        assert flags == []

    def test_flags_high_pe(self):
        flags = EquityAgent._detect_red_flags({"pe_ratio": 45.0})
        assert any("P/E" in f for f in flags)

    def test_flags_high_debt(self):
        flags = EquityAgent._detect_red_flags({"debt_to_equity": 2.0})
        assert any("debt" in f.lower() for f in flags)

    def test_flags_negative_fcf(self):
        flags = EquityAgent._detect_red_flags({"fcf": -1e9})
        assert any("cash flow" in f.lower() for f in flags)

    def test_flags_weak_fcf_yield(self):
        flags = EquityAgent._detect_red_flags({"fcf_yield": 0.005})
        assert any("FCF yield" in f for f in flags)

    def test_flags_declining_earnings(self):
        flags = EquityAgent._detect_red_flags({"earnings_growth": -0.10})
        assert any("earnings" in f.lower() for f in flags)

    def test_flags_declining_revenue(self):
        flags = EquityAgent._detect_red_flags({"revenue_growth": -0.05})
        assert any("revenue" in f.lower() for f in flags)

    def test_flags_high_valuation_slow_growth(self):
        flags = EquityAgent._detect_red_flags({"pe_ratio": 35.0, "earnings_growth": 0.02})
        assert any("slow growth" in f.lower() for f in flags)

    def test_flags_high_debt_weak_cash(self):
        flags = EquityAgent._detect_red_flags({"debt_to_equity": 1.2, "fcf_yield": 0.010})
        assert any("debt" in f.lower() and "cash" in f.lower() for f in flags)

    def test_multiple_red_flags(self):
        flags = EquityAgent._detect_red_flags({
            "pe_ratio": 50.0, "debt_to_equity": 2.5,
            "fcf": -1e9, "earnings_growth": -0.20,
        })
        assert len(flags) >= 3

    @pytest.mark.asyncio
    async def test_no_morningstar_report_returns_none(self, tmp_path):
        agent = EquityAgent(api_key="test", reports_dir=tmp_path)
        result = await agent._fetch_fundamentals("NOTFOUND")
        assert result is None

    @pytest.mark.asyncio
    async def test_analyze_returns_none_without_report(self, tmp_path):
        agent = EquityAgent(api_key="test", reports_dir=tmp_path)
        result = await agent.analyze("NOTFOUND")
        assert result is None


# ============================================================================
# CFOAgent — context building and response parsing
# ============================================================================

@pytest.mark.unit
class TestCFOAgentContextBuilding:

    def _make_batch_item(self, ticker="NVDA", price=222.82, with_equity=True, with_strategy=True):
        quote = QuoteData(ticker=ticker, price=price)
        strategy = Signal(
            ticker=ticker, recommendation="BUY", confidence=0.7,
            reasoning=f"{ticker} technical analysis: | RSI 52 (neutral) | Golden cross",
            date=datetime.now(),
        ) if with_strategy else None
        equity = EquityData(
            ticker=ticker, pe_ratio=32.33, pb_ratio=26.16, fcf=22.94e9,
            revenue_growth=1.259, earnings_growth=5.849,
            fair_value=280.0, price_to_fair_value=0.75,
            economic_moat="Wide", morningstar_rating=4,
            uncertainty="Very High", capital_allocation="Exemplary",
        ) if with_equity else None
        return {"ticker": ticker, "quote": quote, "strategy": strategy, "equity": equity}

    def test_context_includes_fair_value(self):
        item = self._make_batch_item()
        ctx = CFOAgent._build_batch_context([item])
        assert "280.00" in ctx
        assert "P/FVE" in ctx

    def test_context_includes_moat(self):
        item = self._make_batch_item()
        ctx = CFOAgent._build_batch_context([item])
        assert "Wide" in ctx

    def test_context_includes_star_rating(self):
        item = self._make_batch_item()
        ctx = CFOAgent._build_batch_context([item])
        assert "★★★★" in ctx

    def test_context_includes_fcf(self):
        item = self._make_batch_item()
        ctx = CFOAgent._build_batch_context([item])
        assert "FCF" in ctx

    def test_context_includes_red_flags(self):
        item = self._make_batch_item()
        item["equity"].red_flags = ["High P/E ratio: 50.0", "Declining revenue: -5%"]
        ctx = CFOAgent._build_batch_context([item])
        assert "RED FLAGS" in ctx
        assert "High P/E" in ctx

    def test_context_skips_zero_confidence_technical(self):
        item = self._make_batch_item()
        item["strategy"] = Signal(
            ticker="NVDA", recommendation="HOLD", confidence=0.0,
            reasoning="No technical signals detected", date=datetime.now(),
        )
        ctx = CFOAgent._build_batch_context([item])
        assert "Technical:" not in ctx

    def test_context_multiple_tickers(self):
        items = [
            self._make_batch_item("NVDA"),
            self._make_batch_item("AAPL", price=315.20),
        ]
        ctx = CFOAgent._build_batch_context(items)
        assert "NVDA" in ctx
        assert "AAPL" in ctx

    def test_context_requests_json_output(self):
        ctx = CFOAgent._build_batch_context([self._make_batch_item()])
        assert "JSON" in ctx


@pytest.mark.unit
class TestCFOAgentResponseParsing:

    def _batch_input(self, tickers):
        return [{"ticker": t} for t in tickers]

    def test_parse_valid_json(self):
        response = json.dumps([
            {"ticker": "NVDA", "recommendation": "BUY", "confidence": 0.75, "reasoning": "Undervalued wide-moat"},
            {"ticker": "MU", "recommendation": "SELL", "confidence": 0.80, "reasoning": "Declining revenue"},
        ])
        signals = CFOAgent._parse_batch_response(response, self._batch_input(["NVDA", "MU"]))
        by_ticker = {s.ticker: s for s in signals}
        assert by_ticker["NVDA"].recommendation == "BUY"
        assert by_ticker["NVDA"].confidence == 0.75
        assert by_ticker["MU"].recommendation == "SELL"

    def test_parse_json_with_markdown_fencing(self):
        response = "```json\n" + json.dumps([
            {"ticker": "AAPL", "recommendation": "HOLD", "confidence": 0.5, "reasoning": "Neutral"}
        ]) + "\n```"
        signals = CFOAgent._parse_batch_response(response, self._batch_input(["AAPL"]))
        assert signals[0].recommendation == "HOLD"

    def test_parse_fills_missing_tickers_with_hold(self):
        response = json.dumps([
            {"ticker": "NVDA", "recommendation": "BUY", "confidence": 0.7, "reasoning": "Good"}
        ])
        signals = CFOAgent._parse_batch_response(response, self._batch_input(["NVDA", "AAPL"]))
        by_ticker = {s.ticker: s for s in signals}
        assert "NVDA" in by_ticker
        assert "AAPL" in by_ticker
        assert by_ticker["AAPL"].recommendation == "HOLD"
        assert by_ticker["AAPL"].confidence == 0.5

    def test_parse_clamps_invalid_confidence(self):
        response = json.dumps([
            {"ticker": "NVDA", "recommendation": "BUY", "confidence": 99.0, "reasoning": "..."}
        ])
        signals = CFOAgent._parse_batch_response(response, self._batch_input(["NVDA"]))
        assert signals[0].confidence == 1.0

    def test_parse_invalid_recommendation_defaults_hold(self):
        response = json.dumps([
            {"ticker": "NVDA", "recommendation": "MAYBE", "confidence": 0.6, "reasoning": "..."}
        ])
        signals = CFOAgent._parse_batch_response(response, self._batch_input(["NVDA"]))
        assert signals[0].recommendation == "HOLD"

    def test_parse_fallback_line_format(self):
        response = (
            "TICKER: NVDA\nRECOMMENDATION: BUY\nCONFIDENCE: 0.75\nREASONING: Undervalued\n\n"
            "TICKER: MU\nRECOMMENDATION: SELL\nCONFIDENCE: 0.80\nREASONING: Red flags\n"
        )
        signals = CFOAgent._parse_batch_response(response, self._batch_input(["NVDA", "MU"]))
        by_ticker = {s.ticker: s for s in signals}
        assert by_ticker["NVDA"].recommendation == "BUY"
        assert by_ticker["MU"].recommendation == "SELL"

    def test_parse_empty_response_all_hold(self):
        signals = CFOAgent._parse_batch_response("", self._batch_input(["NVDA", "AAPL"]))
        assert all(s.recommendation == "HOLD" for s in signals)
        assert len(signals) == 2

    @pytest.mark.asyncio
    async def test_batch_analyze_returns_signals_on_api_error(self):
        agent = CFOAgent(api_key="test")
        agent.client = MagicMock()
        agent.client.messages.create.side_effect = Exception("API error")

        signals = await agent.batch_analyze([{"ticker": "NVDA"}, {"ticker": "AAPL"}])
        assert len(signals) == 2
        assert all(s.recommendation == "HOLD" for s in signals)
