"""EquityAgent: Fundamental analysis (PE, debt, FCF, red flags)."""

import asyncio
import logging
from typing import Optional
from datetime import datetime

from fstack.agents.base import ThrottledAPIAgent
from fstack.core.models import EquityData
from fstack.core.errors import EquityServiceError, APIError

logger = logging.getLogger(__name__)


class EquityAgent(ThrottledAPIAgent):
    """Fetch and analyze fundamental equity data."""

    def __init__(self, api_key: str):
        """Initialize EquityAgent.

        Args:
            api_key: API key for equity data provider (Alpha Vantage, etc.)
        """
        super().__init__(name="EquityAgent", max_calls_per_minute=5)
        self.api_key = api_key

    async def analyze(self, ticker: str, **kwargs) -> Optional[EquityData]:
        """Fetch fundamental data and detect red flags.

        Args:
            ticker: Stock ticker symbol
            **kwargs: Additional parameters (unused)

        Returns:
            EquityData with fundamentals and red flags, or None on failure
        """
        try:
            await self.check_rate_limit()
            self.logger.debug(f"Analyzing fundamentals for {ticker}")

            # Fetch company fundamentals
            fundamentals = await self._fetch_fundamentals(ticker)
            if not fundamentals:
                self.logger.warning(f"No fundamental data for {ticker}")
                return None

            # Detect red flags
            red_flags = self._detect_red_flags(fundamentals)

            result = EquityData(
                ticker=ticker,
                pe_ratio=fundamentals.get("pe_ratio"),
                pb_ratio=fundamentals.get("pb_ratio"),
                debt_to_equity=fundamentals.get("debt_to_equity"),
                fcf=fundamentals.get("fcf"),
                fcf_yield=fundamentals.get("fcf_yield"),
                dividend_yield=fundamentals.get("dividend_yield"),
                earnings_growth=fundamentals.get("earnings_growth"),
                revenue_growth=fundamentals.get("revenue_growth"),
                red_flags=red_flags,
                timestamp=datetime.now(),
            )

            self.logger.info(
                f"Fundamentals: {ticker} PE={result.pe_ratio} "
                f"D/E={result.debt_to_equity} FCF={result.fcf} "
                f"Red flags: {len(red_flags)}"
            )
            return result

        except Exception as e:
            self.logger.error(f"Equity analysis failed for {ticker}: {e}")
            raise EquityServiceError(f"Equity analysis failed for {ticker}: {e}")

    async def _fetch_fundamentals(self, ticker: str) -> Optional[dict]:
        """Fetch fundamental data from API.

        For MVP, returns mock data with realistic structure.
        In production, integrate with Alpha Vantage, Yahoo Finance API, etc.

        Args:
            ticker: Stock ticker

        Returns:
            Dict with fundamentals or None
        """
        try:
            # Mock implementation for MVP
            # In production, call actual API:
            # loop = asyncio.get_event_loop()
            # data = await loop.run_in_executor(None, self._call_api, ticker)

            loop = asyncio.get_event_loop()
            data = await loop.run_in_executor(None, self._mock_fundamentals, ticker)
            return data

        except Exception as e:
            self.logger.error(f"Failed to fetch fundamentals for {ticker}: {e}")
            raise APIError(f"Fundamentals API failed: {e}")

    @staticmethod
    def _mock_fundamentals(ticker: str) -> dict:
        """Mock fundamental data for MVP.

        Replace with real API calls in production.

        Args:
            ticker: Stock ticker

        Returns:
            Mock fundamental data
        """
        # Simulate realistic fundamentals
        # In production, this is replaced with real API calls
        mock_data = {
            "NVDA": {
                "pe_ratio": 45.2,
                "pb_ratio": 8.5,
                "debt_to_equity": 0.35,
                "fcf": 12.5e9,  # $12.5B
                "fcf_yield": 0.032,  # 3.2%
                "dividend_yield": 0.005,  # 0.5%
                "earnings_growth": 0.35,  # 35% YoY
                "revenue_growth": 0.28,  # 28% YoY
            },
            "TSLA": {
                "pe_ratio": 62.1,
                "pb_ratio": 15.2,
                "debt_to_equity": 0.42,
                "fcf": 8.2e9,  # $8.2B
                "fcf_yield": 0.018,  # 1.8%
                "dividend_yield": 0.0,  # No dividend
                "earnings_growth": 0.25,  # 25% YoY
                "revenue_growth": 0.20,  # 20% YoY
            },
            "F": {
                "pe_ratio": 5.8,
                "pb_ratio": 0.8,
                "debt_to_equity": 1.8,  # High debt
                "fcf": 2.1e9,  # $2.1B
                "fcf_yield": 0.005,  # 0.5%
                "dividend_yield": 0.045,  # 4.5%
                "earnings_growth": -0.05,  # -5% YoY (declining)
                "revenue_growth": -0.08,  # -8% YoY (declining)
            },
        }

        return mock_data.get(ticker, {
            "pe_ratio": 25.0,
            "pb_ratio": 3.5,
            "debt_to_equity": 0.6,
            "fcf": 5e9,
            "fcf_yield": 0.02,
            "dividend_yield": 0.02,
            "earnings_growth": 0.10,
            "revenue_growth": 0.08,
        })

    @staticmethod
    def _detect_red_flags(fundamentals: dict) -> list[str]:
        """Detect warning signs in fundamental data.

        Args:
            fundamentals: Fundamental data dict

        Returns:
            List of red flag descriptions
        """
        red_flags = []

        # High valuation
        pe = fundamentals.get("pe_ratio")
        if pe and pe > 40:
            red_flags.append(f"High P/E ratio: {pe:.1f}")

        # High debt
        de = fundamentals.get("debt_to_equity")
        if de and de > 1.5:
            red_flags.append(f"High debt: D/E = {de:.2f}")

        # Negative FCF
        fcf = fundamentals.get("fcf")
        if fcf and fcf < 0:
            red_flags.append("Negative free cash flow")

        # Weak FCF yield
        fcf_yield = fundamentals.get("fcf_yield")
        if fcf_yield and fcf_yield < 0.01:
            red_flags.append(f"Weak FCF yield: {fcf_yield:.1%}")

        # Declining earnings
        eg = fundamentals.get("earnings_growth")
        if eg and eg < 0:
            red_flags.append(f"Declining earnings: {eg:.1%}")

        # Declining revenue
        rg = fundamentals.get("revenue_growth")
        if rg and rg < 0:
            red_flags.append(f"Declining revenue: {rg:.1%}")

        # Low/negative growth despite high valuation
        if pe and pe > 30 and eg and eg < 0.05:
            red_flags.append("High valuation with slow growth")

        # High debt AND low FCF yield
        if de and de > 1.0 and fcf_yield and fcf_yield < 0.015:
            red_flags.append("High debt with weak cash generation")

        return red_flags

    async def batch_analyze(self, tickers: list[str]) -> dict[str, Optional[EquityData]]:
        """Analyze fundamentals for multiple tickers.

        Args:
            tickers: List of ticker symbols

        Returns:
            Dict of {ticker: EquityData or None}
        """
        tasks = [self.safe_analyze(ticker) for ticker in tickers]
        results = await asyncio.gather(*tasks, return_exceptions=False)
        return {ticker: result for ticker, result in zip(tickers, results)}
