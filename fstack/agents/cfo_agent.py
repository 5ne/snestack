"""CFOAgent: Synthesize all signals via Claude API."""

import json
import logging
from typing import Optional
from datetime import datetime

import anthropic

from fstack.agents.base import BaseAgent
from fstack.core.models import Signal, QuoteData, EquityData, StrategySignal
from fstack.core.errors import APIError

logger = logging.getLogger(__name__)

# System prompt for Claude to synthesize investment signals
CFO_SYSTEM_PROMPT = """You are an expert investment analyst synthesizing multiple signals for investment decisions.

You receive:
- Quote data (current price, technical indicators)
- Strategy signals (RSI, moving average analysis)
- Equity data (PE, debt/equity, FCF, growth rates)

For each investment, provide a recommendation (BUY/SELL/HOLD) and confidence (0-1) based on:
1. Technical momentum (RSI, moving averages)
2. Fundamental value (PE, growth, debt levels)
3. Risk factors (red flags, declining metrics)
4. Your overall investment thesis

Be concise but thorough. Consider both upside potential and downside risk.
Default to HOLD if signals are conflicting or data is insufficient.
Never recommend based on a single metric - synthesize the full picture."""


class CFOAgent(BaseAgent):
    """Claude-powered synthesis of all investment signals."""

    def __init__(self, api_key: str):
        """Initialize CFOAgent.

        Args:
            api_key: Anthropic API key
        """
        super().__init__(name="CFOAgent")
        self.api_key = api_key
        self.client = anthropic.Anthropic(api_key=api_key)

    async def analyze(
        self,
        ticker: str,
        quote: Optional[QuoteData] = None,
        strategy: Optional[StrategySignal] = None,
        equity: Optional[EquityData] = None,
        **kwargs,
    ) -> Optional[Signal]:
        """Synthesize signals for a single ticker.

        Args:
            ticker: Stock ticker
            quote: Quote data
            strategy: Strategy signal
            equity: Equity data
            **kwargs: Unused

        Returns:
            Final Signal recommendation
        """
        try:
            self.logger.debug(f"Synthesizing signals for {ticker}")

            # Build context
            context = self._build_context(ticker, quote, strategy, equity)

            # Call Claude
            response = self.client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=300,
                system=CFO_SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": context,
                    }
                ],
            )

            # Parse response
            result_text = response.content[0].text
            recommendation, confidence, reasoning = self._parse_response(result_text)

            signal = Signal(
                ticker=ticker,
                recommendation=recommendation,
                confidence=confidence,
                reasoning=reasoning,
                date=datetime.now(),
            )

            self.logger.info(
                f"CFO synthesis: {ticker} {recommendation} (conf: {confidence:.2f})"
            )
            return signal

        except Exception as e:
            self.logger.error(f"CFO synthesis failed for {ticker}: {e}")
            # Default to HOLD on error
            return Signal(
                ticker=ticker,
                recommendation="HOLD",
                confidence=0.5,
                reasoning=f"Error in synthesis: {e}",
                date=datetime.now(),
            )

    @staticmethod
    def _build_context(
        ticker: str,
        quote: Optional[QuoteData],
        strategy: Optional[StrategySignal],
        equity: Optional[EquityData],
    ) -> str:
        """Build prompt context from all signals.

        Args:
            ticker: Stock ticker
            quote: Quote data
            strategy: Strategy signal
            equity: Equity data

        Returns:
            Formatted context string
        """
        lines = [f"Analyze {ticker} for investment recommendation:\n"]

        if quote:
            lines.append("QUOTE DATA:")
            lines.append(f"  Price: ${quote.price:.2f}")
            if quote.open:
                lines.append(f"  Open: ${quote.open:.2f}")
            if quote.high and quote.low:
                lines.append(f"  Range: ${quote.low:.2f} - ${quote.high:.2f}")
            if quote.volume:
                lines.append(f"  Volume: {quote.volume:,}")
            lines.append("")

        if strategy:
            lines.append("TECHNICAL ANALYSIS:")
            lines.append(f"  Signal: {strategy.recommendation}")
            lines.append(f"  Confidence: {strategy.confidence:.1%}")
            if strategy.rsi_signal:
                lines.append(f"  RSI: {strategy.rsi_signal}")
            if strategy.ma_signal:
                lines.append(f"  MA: {strategy.ma_signal}")
            lines.append("")

        if equity:
            lines.append("FUNDAMENTAL DATA:")
            if equity.pe_ratio:
                lines.append(f"  P/E Ratio: {equity.pe_ratio:.1f}")
            if equity.pb_ratio:
                lines.append(f"  P/B Ratio: {equity.pb_ratio:.1f}")
            if equity.debt_to_equity:
                lines.append(f"  Debt/Equity: {equity.debt_to_equity:.2f}")
            if equity.fcf:
                fcf_b = equity.fcf / 1e9
                lines.append(f"  Free Cash Flow: ${fcf_b:.1f}B")
            if equity.fcf_yield:
                lines.append(f"  FCF Yield: {equity.fcf_yield:.1%}")
            if equity.dividend_yield:
                lines.append(f"  Dividend Yield: {equity.dividend_yield:.1%}")
            if equity.earnings_growth is not None:
                lines.append(f"  Earnings Growth: {equity.earnings_growth:.1%}")
            if equity.revenue_growth is not None:
                lines.append(f"  Revenue Growth: {equity.revenue_growth:.1%}")
            if equity.red_flags:
                lines.append(f"  RED FLAGS:")
                for flag in equity.red_flags:
                    lines.append(f"    - {flag}")
            lines.append("")

        lines.append("Provide your recommendation in this format:")
        lines.append("RECOMMENDATION: [BUY|SELL|HOLD]")
        lines.append("CONFIDENCE: [0.0-1.0]")
        lines.append("REASONING: [Brief explanation]")

        return "\n".join(lines)

    @staticmethod
    def _parse_response(response_text: str) -> tuple[str, float, str]:
        """Parse Claude response to extract recommendation.

        Args:
            response_text: Raw Claude response

        Returns:
            Tuple of (recommendation, confidence, reasoning)
        """
        lines = response_text.strip().split("\n")

        recommendation = "HOLD"
        confidence = 0.5
        reasoning = response_text

        for line in lines:
            if "RECOMMENDATION:" in line:
                rec = line.split("RECOMMENDATION:")[1].strip().upper()
                if rec in ["BUY", "SELL", "HOLD"]:
                    recommendation = rec
            elif "CONFIDENCE:" in line:
                try:
                    conf_str = line.split("CONFIDENCE:")[1].strip()
                    # Handle both "0.75" and "75%"
                    if "%" in conf_str:
                        confidence = float(conf_str.replace("%", "")) / 100
                    else:
                        confidence = float(conf_str)
                    confidence = max(0.0, min(1.0, confidence))
                except ValueError:
                    confidence = 0.5
            elif "REASONING:" in line:
                reasoning = line.split("REASONING:")[1].strip()

        return (recommendation, round(confidence, 2), reasoning)

    async def batch_analyze(
        self,
        batch_input: list[dict],
    ) -> list[Signal]:
        """Analyze multiple tickers in one Claude call.

        This is the primary use case: batch all signals together.

        Args:
            batch_input: List of {ticker, quote, strategy, equity}

        Returns:
            List of Signals
        """
        try:
            self.logger.debug(f"Batch synthesis for {len(batch_input)} tickers")

            # Build batch context
            context = self._build_batch_context(batch_input)

            # Call Claude once for all
            response = self.client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=2000,
                system=CFO_SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": context,
                    }
                ],
            )

            # Parse batch response
            result_text = response.content[0].text
            signals = self._parse_batch_response(result_text, batch_input)

            self.logger.info(f"Batch synthesis complete: {len(signals)} signals")
            return signals

        except Exception as e:
            self.logger.error(f"Batch synthesis failed: {e}")
            # Return HOLD defaults on error
            return [
                Signal(
                    ticker=item["ticker"],
                    recommendation="HOLD",
                    confidence=0.5,
                    reasoning=f"Error in batch synthesis: {e}",
                    date=datetime.now(),
                )
                for item in batch_input
            ]

    @staticmethod
    def _build_batch_context(batch_input: list[dict]) -> str:
        """Build context for batch analysis.

        Args:
            batch_input: List of {ticker, quote, strategy, equity}

        Returns:
            Formatted context
        """
        lines = ["Analyze these investments and provide recommendations for each:\n"]

        for i, item in enumerate(batch_input, 1):
            ticker = item["ticker"]
            quote = item.get("quote")
            strategy = item.get("strategy")
            equity = item.get("equity")

            lines.append(f"{i}. {ticker.upper()}")

            if quote:
                lines.append(f"   Price: ${quote.price:.2f}")
            if strategy:
                lines.append(f"   Technical: {strategy.recommendation} ({strategy.confidence:.0%})")
            if equity:
                if equity.pe_ratio:
                    lines.append(f"   P/E: {equity.pe_ratio:.1f}")
                if equity.red_flags:
                    lines.append(f"   Flags: {', '.join(equity.red_flags)}")
            lines.append("")

        lines.append("For each, provide:")
        lines.append("TICKER: [symbol]")
        lines.append("RECOMMENDATION: [BUY|SELL|HOLD]")
        lines.append("CONFIDENCE: [0.0-1.0]")
        lines.append("REASONING: [Brief explanation]")
        lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _parse_batch_response(
        response_text: str, batch_input: list[dict]
    ) -> list[Signal]:
        """Parse batch response.

        Args:
            response_text: Raw Claude response
            batch_input: Original batch input (for fallback)

        Returns:
            List of Signals
        """
        signals = []

        # Simple line-by-line parsing
        # Production: more robust parsing (JSON, structured output)
        lines = response_text.strip().split("\n")

        current_ticker = None
        current_rec = "HOLD"
        current_conf = 0.5
        current_reasoning = ""

        for line in lines:
            line = line.strip()
            if line.startswith("TICKER:"):
                current_ticker = line.split("TICKER:")[1].strip().upper()
            elif line.startswith("RECOMMENDATION:"):
                rec = line.split("RECOMMENDATION:")[1].strip().upper()
                if rec in ["BUY", "SELL", "HOLD"]:
                    current_rec = rec
            elif line.startswith("CONFIDENCE:"):
                try:
                    conf_str = line.split("CONFIDENCE:")[1].strip()
                    if "%" in conf_str:
                        current_conf = float(conf_str.replace("%", "")) / 100
                    else:
                        current_conf = float(conf_str)
                    current_conf = max(0.0, min(1.0, current_conf))
                except ValueError:
                    current_conf = 0.5
            elif line.startswith("REASONING:"):
                current_reasoning = line.split("REASONING:")[1].strip()
                # Create signal at reasoning line (end of record)
                if current_ticker:
                    signals.append(
                        Signal(
                            ticker=current_ticker,
                            recommendation=current_rec,
                            confidence=current_conf,
                            reasoning=current_reasoning,
                            date=datetime.now(),
                        )
                    )
                    current_ticker = None
                    current_rec = "HOLD"
                    current_conf = 0.5
                    current_reasoning = ""

        # Ensure we have signals for all inputs (fill with defaults)
        signal_tickers = {s.ticker for s in signals}
        for item in batch_input:
            if item["ticker"] not in signal_tickers:
                signals.append(
                    Signal(
                        ticker=item["ticker"],
                        recommendation="HOLD",
                        confidence=0.5,
                        reasoning="Parsed from batch response",
                        date=datetime.now(),
                    )
                )

        return signals
