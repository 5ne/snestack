"""Batch analysis orchestration - coordinates all agents."""

import asyncio
import logging
from datetime import datetime
from typing import Optional

from fstack.config import get_config
from fstack.core.db import Database
from fstack.core.models import BatchAnalysisResult, Signal
from fstack.agents.quote_agent import QuoteAgent
from fstack.agents.strategy_agent import StrategyAgent
from fstack.agents.equity_agent import EquityAgent
from fstack.agents.cfo_agent import CFOAgent
from fstack.agents.trader_agent import TraderAgent

logger = logging.getLogger(__name__)


class AnalysisOrchestrator:
    """Coordinates batch analysis across all agents."""

    def __init__(self, db: Database):
        """Initialize orchestrator.

        Args:
            db: Database connection
        """
        self.db = db
        self.config = get_config()

        # Initialize agents
        self.quote_agent = QuoteAgent(
            api_key=self.config.get_finnhub_api_key(),
            db=db,
        )
        self.strategy_agent = StrategyAgent(db=db)
        self.equity_agent = EquityAgent(
            api_key=self.config.get_finnhub_api_key(),  # Could be different API
        )
        self.cfo_agent = CFOAgent(
            api_key=self.config.get_claude_api_key(),
        )
        self.trader_agent = TraderAgent(
            db=db,
            gmail_address=self.config.get_gmail_address(),
            gmail_app_password=self.config.get("FSTACK_GMAIL_APP_PASSWORD"),
            notification_email=self.config.get_notification_email(),
        )

    async def run_batch_analysis(self, dry_run: bool = False) -> BatchAnalysisResult:
        """Run complete batch analysis.

        Flow:
        1. Fetch positions + watchlist
        2. Run Quote/Strategy/Equity agents in parallel
        3. Batch CFO synthesis
        4. Send email with results
        5. Store signals in database

        Args:
            dry_run: If True, don't send email or store signals

        Returns:
            BatchAnalysisResult with signals and any errors
        """
        start_time = datetime.now()
        logger.info("Starting batch analysis")

        try:
            # Get positions and watchlist
            positions = self.db.get_all_positions()
            watchlist = self.db.get_watchlist()

            position_tickers = [p["ticker"] for p in positions]
            watchlist_tickers = [w["ticker"] for w in watchlist]
            all_tickers = position_tickers + watchlist_tickers

            logger.info(
                f"Analyzing {len(position_tickers)} positions + {len(watchlist_tickers)} watchlist"
            )

            if not all_tickers:
                logger.warning("No tickers to analyze")
                return BatchAnalysisResult(
                    signals=[],
                    errors={},
                    start_time=start_time,
                    end_time=datetime.now(),
                    duration_seconds=(datetime.now() - start_time).total_seconds(),
                )

            # Run agents in parallel
            quotes = await self.quote_agent.batch_analyze(all_tickers)
            strategies = await self.strategy_agent.batch_analyze(all_tickers)
            equities = await self.equity_agent.batch_analyze(all_tickers)

            # Prepare batch input for CFO
            cfo_input = []
            for ticker in all_tickers:
                cfo_input.append(
                    {
                        "ticker": ticker,
                        "quote": quotes.get(ticker),
                        "strategy": strategies.get(ticker),
                        "equity": equities.get(ticker),
                    }
                )

            # CFO synthesis (one call for all tickers)
            logger.info("Synthesizing via Claude CFO agent")
            signals = await self.cfo_agent.batch_analyze(cfo_input)

            # Send email
            if not dry_run:
                logger.info(f"Sending email with {len(signals)} signals")
                email_success = await self.trader_agent.send_batch_email(
                    signals,
                    run_date=start_time.strftime("%Y-%m-%d"),
                )
                if not email_success:
                    logger.warning("Email send failed, signals queued for retry")
            else:
                logger.info("[DRY RUN] Would send email")

            # Build result
            errors = {}
            for ticker in all_tickers:
                if ticker not in quotes or quotes[ticker] is None:
                    errors[ticker] = "Quote fetch failed"
                elif ticker not in equities or equities[ticker] is None:
                    errors[ticker] = "Equity fetch failed"

            end_time = datetime.now()
            duration = (end_time - start_time).total_seconds()

            logger.info(
                f"Batch analysis complete: {len(signals)} signals, "
                f"{len(errors)} errors, {duration:.1f}s"
            )

            return BatchAnalysisResult(
                signals=signals,
                errors=errors,
                start_time=start_time,
                end_time=end_time,
                duration_seconds=duration,
            )

        except Exception as e:
            logger.error(f"Batch analysis failed: {e}", exc_info=True)
            return BatchAnalysisResult(
                signals=[],
                errors={"_orchestrator": str(e)},
                start_time=start_time,
                end_time=datetime.now(),
                duration_seconds=(datetime.now() - start_time).total_seconds(),
            )

    async def analyze_single_ticker(self, ticker: str) -> Optional[Signal]:
        """Analyze a single ticker.

        Args:
            ticker: Ticker symbol

        Returns:
            Final Signal recommendation
        """
        logger.info(f"Analyzing single ticker: {ticker}")

        try:
            # Fetch all signals
            quote = await self.quote_agent.safe_analyze(ticker)
            strategy = await self.strategy_agent.safe_analyze(ticker)
            equity = await self.equity_agent.safe_analyze(ticker)

            # CFO synthesis
            cfo_input = [
                {
                    "ticker": ticker,
                    "quote": quote,
                    "strategy": strategy,
                    "equity": equity,
                }
            ]
            signals = await self.cfo_agent.batch_analyze(cfo_input)

            if signals:
                return signals[0]
            else:
                return None

        except Exception as e:
            logger.error(f"Single ticker analysis failed: {e}")
            return None

    async def retry_pending_emails(self) -> int:
        """Retry sending pending notifications.

        Returns:
            Number of notifications retried
        """
        logger.info("Retrying pending email notifications")
        return await self.trader_agent.retry_pending_notifications()


async def run_batch(db: Database, dry_run: bool = False) -> BatchAnalysisResult:
    """Convenience function to run batch analysis.

    Args:
        db: Database connection
        dry_run: If True, don't send email

    Returns:
        BatchAnalysisResult
    """
    orchestrator = AnalysisOrchestrator(db)
    return await orchestrator.run_batch_analysis(dry_run=dry_run)


async def run_single(db: Database, ticker: str) -> Optional[Signal]:
    """Convenience function to analyze single ticker.

    Args:
        db: Database connection
        ticker: Ticker symbol

    Returns:
        Signal or None
    """
    orchestrator = AnalysisOrchestrator(db)
    return await orchestrator.analyze_single_ticker(ticker)
