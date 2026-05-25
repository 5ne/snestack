"""StrategyAgent: Technical analysis using RSI, moving averages, volume."""

import logging
from typing import Optional
from datetime import datetime

from fstack.agents.base import BaseAgent
from fstack.core.models import StrategySignal, Signal
from fstack.core.db import Database

logger = logging.getLogger(__name__)


class StrategyAgent(BaseAgent):
    """Rules-based technical analysis engine."""

    def __init__(self, db: Database):
        """Initialize StrategyAgent.

        Args:
            db: Database connection for fetching quotes
        """
        super().__init__(name="StrategyAgent")
        self.db = db

    async def analyze(self, ticker: str, **kwargs) -> Optional[Signal]:
        """Analyze ticker using technical indicators.

        Returns a Signal with BUY/SELL/HOLD and confidence based on:
        - RSI (oversold/overbought)
        - MA-50/MA-200 crossovers
        - Volume trends

        Args:
            ticker: Stock ticker symbol
            **kwargs: Additional parameters (unused)

        Returns:
            Signal with recommendation and confidence, or None on failure
        """
        try:
            self.logger.debug(f"Analyzing {ticker}")

            # Fetch latest quote
            quote = self.db.get_latest_quote(ticker)
            if not quote:
                self.logger.warning(f"No quote data for {ticker}")
                return Signal(
                    ticker=ticker,
                    recommendation="HOLD",
                    confidence=0,
                    reasoning="No quote data available",
                    date=datetime.now(),
                )

            # Extract indicators
            rsi = quote.get("rsi")
            ma_50 = quote.get("ma_50")
            ma_200 = quote.get("ma_200")
            close = quote.get("close")

            signals = []
            weights = []

            # RSI signal
            if rsi is not None:
                rsi_signal, rsi_weight = self._rsi_signal(rsi, close)
                if rsi_signal:
                    signals.append(rsi_signal)
                    weights.append(rsi_weight)

            # Moving average signal
            if ma_50 is not None and ma_200 is not None:
                ma_signal, ma_weight = self._ma_signal(close, ma_50, ma_200)
                if ma_signal:
                    signals.append(ma_signal)
                    weights.append(ma_weight)

            # Volume signal (if available)
            volume = quote.get("volume")
            if volume:
                vol_signal, vol_weight = self._volume_signal(ticker, volume)
                if vol_signal:
                    signals.append(vol_signal)
                    weights.append(vol_weight)

            # Synthesize final signal
            if not signals:
                # No signals matched
                return Signal(
                    ticker=ticker,
                    recommendation="HOLD",
                    confidence=0,
                    reasoning="No technical signals detected",
                    date=datetime.now(),
                )

            # Weighted consensus
            recommendation = self._weighted_consensus(signals, weights)
            confidence = sum(weights) / len(weights) if weights else 0.5

            reasoning = self._build_reasoning(ticker, rsi, ma_50, ma_200, close)

            result = Signal(
                ticker=ticker,
                recommendation=recommendation,
                confidence=round(confidence, 2),
                reasoning=reasoning,
                date=datetime.now(),
            )

            self.logger.info(
                f"Signal: {ticker} {recommendation} (conf: {confidence:.2f})"
            )
            return result

        except Exception as e:
            self.logger.error(f"Strategy analysis failed for {ticker}: {e}")
            return Signal(
                ticker=ticker,
                recommendation="HOLD",
                confidence=0,
                reasoning=f"Analysis error: {e}",
                date=datetime.now(),
            )

    @staticmethod
    def _rsi_signal(rsi: float, price: float) -> tuple[Optional[str], Optional[float]]:
        """Generate signal from RSI.

        Args:
            rsi: RSI value (0-100)
            price: Current price (for context)

        Returns:
            Tuple of (signal, weight) where signal is BUY/SELL/HOLD, weight is 0-1
        """
        if rsi < 30:
            return ("BUY", 0.8)  # Oversold
        elif rsi > 70:
            return ("SELL", 0.6)  # Overbought
        elif rsi < 40:
            return ("BUY", 0.4)  # Weak buying pressure
        elif rsi > 60:
            return ("SELL", 0.3)  # Weak selling pressure
        else:
            return (None, None)  # Neutral

    @staticmethod
    def _ma_signal(
        price: float, ma_50: float, ma_200: float
    ) -> tuple[Optional[str], Optional[float]]:
        """Generate signal from moving average crossovers.

        Args:
            price: Current price
            ma_50: 50-day moving average
            ma_200: 200-day moving average

        Returns:
            Tuple of (signal, weight)
        """
        # Golden cross: MA-50 above MA-200
        if ma_50 > ma_200:
            if price > ma_50:
                return ("BUY", 0.7)  # Strong uptrend
            elif price > ma_200:
                return ("BUY", 0.5)  # Uptrend but pullback
            else:
                return (None, None)  # Undefined
        # Death cross: MA-50 below MA-200
        elif ma_50 < ma_200:
            if price < ma_50:
                return ("SELL", 0.7)  # Strong downtrend
            elif price < ma_200:
                return ("SELL", 0.5)  # Downtrend but bounce
            else:
                return (None, None)  # Undefined
        else:
            return (None, None)  # Moving averages equal (rare)

    def _volume_signal(self, ticker: str, current_volume: int) -> tuple[Optional[str], Optional[float]]:
        """Generate signal from volume analysis.

        Args:
            ticker: Stock ticker
            current_volume: Current day volume

        Returns:
            Tuple of (signal, weight)
        """
        # Fetch last 20 quotes to calculate average volume
        quotes = self.db.get_quotes(ticker)
        if not quotes or len(quotes) < 20:
            return (None, None)

        volumes = [q.get("volume") or 0 for q in quotes[:20]]
        avg_volume = sum(volumes) / len(volumes) if volumes else 0

        if current_volume > avg_volume * 1.5:
            # High volume — signal likely significant
            return (None, 0.3)  # Just boost confidence of other signals
        elif current_volume < avg_volume * 0.5:
            # Low volume — less conviction
            return (None, None)

        return (None, None)

    @staticmethod
    def _weighted_consensus(signals: list[str], weights: list[float]) -> str:
        """Combine signals into final recommendation.

        Args:
            signals: List of BUY/SELL/HOLD
            weights: Confidence weights for each signal

        Returns:
            Final recommendation: BUY, SELL, or HOLD
        """
        if not signals:
            return "HOLD"

        # Count votes
        buy_weight = sum(w for s, w in zip(signals, weights) if s == "BUY")
        sell_weight = sum(w for s, w in zip(signals, weights) if s == "SELL")
        total_weight = sum(weights)

        if total_weight == 0:
            return "HOLD"

        buy_ratio = buy_weight / total_weight
        sell_ratio = sell_weight / total_weight

        if buy_ratio > sell_ratio and buy_ratio > 0.4:
            return "BUY"
        elif sell_ratio > buy_ratio and sell_ratio > 0.4:
            return "SELL"
        else:
            return "HOLD"

    @staticmethod
    def _build_reasoning(
        ticker: str, rsi: Optional[float], ma_50: Optional[float], ma_200: Optional[float], price: Optional[float]
    ) -> str:
        """Build human-readable reasoning string.

        Args:
            ticker: Stock ticker
            rsi: RSI value
            ma_50: 50-day MA
            ma_200: 200-day MA
            price: Current price

        Returns:
            Reasoning text
        """
        parts = [f"{ticker} technical analysis:"]

        if rsi is not None:
            if rsi < 30:
                parts.append(f"RSI {rsi:.0f} (oversold)")
            elif rsi > 70:
                parts.append(f"RSI {rsi:.0f} (overbought)")
            else:
                parts.append(f"RSI {rsi:.0f} (neutral)")

        if ma_50 and ma_200 and price:
            if ma_50 > ma_200:
                parts.append("Golden cross: 50MA > 200MA")
            elif ma_50 < ma_200:
                parts.append("Death cross: 50MA < 200MA")

            if price > ma_50:
                parts.append(f"Price ${price:.2f} above 50MA ${ma_50:.2f}")
            else:
                parts.append(f"Price ${price:.2f} below 50MA ${ma_50:.2f}")

        return " | ".join(parts)

    async def batch_analyze(self, tickers: list[str]) -> dict[str, Optional[Signal]]:
        """Analyze multiple tickers.

        Args:
            tickers: List of ticker symbols

        Returns:
            Dict of {ticker: Signal or None}
        """
        results = {}
        for ticker in tickers:
            result = await self.safe_analyze(ticker)
            results[ticker] = result
        return results
