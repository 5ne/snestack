"""QuoteAgent: Fetch price data and technical indicators from Finnhub."""

import asyncio
import logging
from typing import Optional
from datetime import datetime, timedelta
import finnhub

from fstack.agents.base import ThrottledAPIAgent, retry_async
from fstack.core.models import Quote, QuoteData
from fstack.core.errors import QuoteServiceError, APIError
from fstack.core.db import Database

logger = logging.getLogger(__name__)


class QuoteAgent(ThrottledAPIAgent):
    """Fetch OHLCV data and calculate technical indicators."""

    def __init__(self, api_key: str, db: Optional[Database] = None):
        """Initialize QuoteAgent.

        Args:
            api_key: Finnhub API key
            db: Database connection (optional, for storing quotes)
        """
        super().__init__(
            name="QuoteAgent",
            max_calls_per_minute=60,  # Finnhub free tier limit
            warn_threshold=0.7,
        )
        self.api_key = api_key
        self.db = db
        self.client = finnhub.Client(api_key=api_key)

    @retry_async(max_attempts=3, initial_delay=1.0, backoff_multiplier=2.0)
    async def analyze(self, ticker: str, **kwargs) -> Optional[QuoteData]:
        """Fetch quote data and calculate technical indicators.

        Args:
            ticker: Stock ticker symbol
            **kwargs: Additional parameters (unused for quotes)

        Returns:
            QuoteData with OHLCV and technical indicators, or None on failure
        """
        await self.check_rate_limit()

        try:
            self.logger.debug(f"Fetching quote for {ticker}")

            # Fetch current quote (non-async, wrapped in sync)
            quote_data = await self._fetch_current_quote(ticker)
            if not quote_data:
                self.logger.warning(f"No quote data for {ticker}")
                return None

            # Fetch historical data for technical indicators
            historical = await self._fetch_historical(ticker)

            # Calculate RSI, moving averages
            rsi = self._calculate_rsi(historical) if historical else None
            ma_50 = self._calculate_moving_average(historical, period=50) if historical else None
            ma_200 = self._calculate_moving_average(historical, period=200) if historical else None

            result = QuoteData(
                ticker=ticker,
                price=quote_data.get("c"),
                open=quote_data.get("o"),
                high=quote_data.get("h"),
                low=quote_data.get("l"),
                volume=quote_data.get("v"),
                timestamp=datetime.now(),
            )

            # Store in database if available
            if self.db and all(
                [
                    quote_data.get("o"),
                    quote_data.get("h"),
                    quote_data.get("l"),
                    quote_data.get("c"),
                ]
            ):
                today = datetime.now().date().isoformat()
                self.db.add_quote(
                    ticker=ticker,
                    date=today,
                    open_=quote_data.get("o"),
                    high=quote_data.get("h"),
                    low=quote_data.get("l"),
                    close=quote_data.get("c"),
                    volume=quote_data.get("v", 0),
                    rsi=rsi,
                    ma_50=ma_50,
                    ma_200=ma_200,
                )

            self.logger.info(f"Quote fetched: {ticker} @ ${result.price:.2f}")
            return result

        except Exception as e:
            self.logger.error(f"Failed to fetch quote for {ticker}: {e}")
            raise QuoteServiceError(f"Quote fetch failed for {ticker}: {e}")

    async def _fetch_current_quote(self, ticker: str) -> Optional[dict]:
        """Fetch current quote from Finnhub.

        Args:
            ticker: Stock ticker

        Returns:
            Quote data dict {c: close, h: high, l: low, o: open, v: volume, t: timestamp}
        """
        try:
            # Run blocking Finnhub call in thread pool
            loop = asyncio.get_event_loop()
            quote = await loop.run_in_executor(
                None, self.client.quote, ticker
            )
            return quote
        except Exception as e:
            self.logger.error(f"Finnhub API error for {ticker}: {e}")
            raise APIError(f"Finnhub quote API failed: {e}")

    async def _fetch_historical(self, ticker: str, days: int = 250) -> Optional[list]:
        """Fetch historical daily data for technical indicators.

        Args:
            ticker: Stock ticker
            days: Number of days of history (default 250 ≈ 1 year trading days)

        Returns:
            List of daily close prices, newest last
        """
        try:
            loop = asyncio.get_event_loop()
            # Finnhub candle endpoint: resolution='D' for daily
            candles = await loop.run_in_executor(
                None, self.client.candles, ticker, "D", 1, int((datetime.now() - timedelta(days=days)).timestamp()), int(datetime.now().timestamp())
            )

            if not candles or "c" not in candles:
                return None

            # Return list of close prices
            return candles.get("c", [])

        except Exception as e:
            self.logger.warning(f"Failed to fetch historical data for {ticker}: {e}")
            return None

    @staticmethod
    def _calculate_rsi(prices: list, period: int = 14) -> Optional[float]:
        """Calculate Relative Strength Index (RSI).

        Args:
            prices: List of close prices
            period: RSI period (default 14)

        Returns:
            RSI value 0-100, or None if insufficient data
        """
        if not prices or len(prices) < period + 1:
            return None

        # Take last N+1 prices for calculation
        prices = prices[-(period + 1) :]

        # Calculate gains and losses
        gains = []
        losses = []

        for i in range(1, len(prices)):
            change = prices[i] - prices[i - 1]
            if change > 0:
                gains.append(change)
                losses.append(0)
            else:
                gains.append(0)
                losses.append(-change)

        avg_gain = sum(gains) / period
        avg_loss = sum(losses) / period

        if avg_loss == 0:
            return 100.0 if avg_gain > 0 else 50.0

        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        return round(rsi, 2)

    @staticmethod
    def _calculate_moving_average(prices: list, period: int) -> Optional[float]:
        """Calculate simple moving average.

        Args:
            prices: List of close prices
            period: Moving average period (50 or 200)

        Returns:
            Moving average value, or None if insufficient data
        """
        if not prices or len(prices) < period:
            return None

        # Take last N prices
        recent = prices[-period:]
        avg = sum(recent) / len(recent)
        return round(avg, 2)

    async def batch_analyze(self, tickers: list[str]) -> dict[str, Optional[QuoteData]]:
        """Analyze multiple tickers concurrently.

        Args:
            tickers: List of ticker symbols

        Returns:
            Dict of {ticker: QuoteData or None}
        """
        tasks = [self.safe_analyze(ticker) for ticker in tickers]
        results = await asyncio.gather(*tasks, return_exceptions=False)
        return {ticker: result for ticker, result in zip(tickers, results)}
