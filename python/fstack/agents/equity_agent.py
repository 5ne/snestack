"""EquityAgent: Fundamental analysis (PE, debt, FCF, red flags)."""

import asyncio
import logging
from pathlib import Path
from typing import Optional
from datetime import datetime

from fstack.agents.base import ThrottledAPIAgent
from fstack.core.models import EquityData
from fstack.core.errors import EquityServiceError, APIError
from fstack.tools.morningstar_parser import find_report, parse_morningstar_pdf

logger = logging.getLogger(__name__)


class EquityAgent(ThrottledAPIAgent):
    """Fetch and analyze fundamental equity data."""

    def __init__(self, api_key: str, reports_dir: Optional[Path] = None):
        """Initialize EquityAgent.

        Args:
            api_key: API key for equity data provider (Alpha Vantage, etc.)
            reports_dir: Directory containing Morningstar PDFs (default: fstack/reports)
        """
        super().__init__(name="EquityAgent", max_calls_per_minute=5)
        self.api_key = api_key
        self.reports_dir = reports_dir or Path("fstack/reports")

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
                fair_value=fundamentals.get("fair_value"),
                price_to_fair_value=fundamentals.get("price_to_fair_value"),
                economic_moat=fundamentals.get("economic_moat"),
                morningstar_rating=fundamentals.get("morningstar_rating"),
                uncertainty=fundamentals.get("uncertainty"),
                capital_allocation=fundamentals.get("capital_allocation"),
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
        """Fetch fundamental data from Morningstar PDF if available.

        Args:
            ticker: Stock ticker

        Returns:
            Dict with fundamentals, or None if no report found
        """
        try:
            loop = asyncio.get_event_loop()
            data = await loop.run_in_executor(None, self._parse_morningstar, ticker)
            return data if data else None

        except Exception as e:
            self.logger.error(f"Failed to fetch fundamentals for {ticker}: {e}")
            raise APIError(f"Fundamentals API failed: {e}")

    def _parse_morningstar(self, ticker: str) -> Optional[dict]:
        """Parse Morningstar PDF for this ticker."""
        pdf_path = find_report(ticker, self.reports_dir)
        if not pdf_path:
            self.logger.warning(f"No Morningstar report found for {ticker} in {self.reports_dir}")
            return None
        return parse_morningstar_pdf(pdf_path) or None

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
