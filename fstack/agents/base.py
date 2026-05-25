"""Base agent class with retry logic for fstack.

All analysis agents inherit from BaseAgent and get automatic retry,
logging, and error handling.
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from functools import wraps
from typing import Any, Awaitable, Callable, Optional, TypeVar
from datetime import datetime

from fstack.core.errors import FstackError, APIError

T = TypeVar("T")

logger = logging.getLogger(__name__)


def retry_async(
    max_attempts: int = 3,
    initial_delay: float = 1.0,
    backoff_multiplier: float = 2.0,
    max_delay: float = 60.0,
):
    """Decorator for async functions with exponential backoff retry.

    Args:
        max_attempts: Maximum number of attempts
        initial_delay: Initial delay in seconds
        backoff_multiplier: Multiplier for exponential backoff
        max_delay: Maximum delay in seconds
    """

    def decorator(func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        @wraps(func)
        async def wrapper(*args, **kwargs) -> Optional[T]:
            delay = initial_delay
            last_error = None

            for attempt in range(1, max_attempts + 1):
                try:
                    logger.debug(f"Attempt {attempt}/{max_attempts} for {func.__name__}")
                    return await func(*args, **kwargs)
                except APIError as e:
                    last_error = e
                    if attempt == max_attempts:
                        logger.error(
                            f"All {max_attempts} attempts failed for {func.__name__}: {e}"
                        )
                        raise
                    logger.warning(
                        f"Attempt {attempt} failed for {func.__name__}: {e}. "
                        f"Retrying in {delay}s..."
                    )
                    await asyncio.sleep(delay)
                    delay = min(delay * backoff_multiplier, max_delay)
                except Exception as e:
                    # Non-API errors: don't retry, just fail
                    logger.error(f"Unrecoverable error in {func.__name__}: {e}")
                    raise

            return None

        return wrapper

    return decorator


class BaseAgent(ABC):
    """Base class for all analysis agents.

    Provides:
    - Retry logic with exponential backoff
    - Structured logging
    - Error handling
    - Common agent interface
    """

    def __init__(self, name: str = None, max_retries: int = 3):
        """Initialize base agent.

        Args:
            name: Agent name for logging
            max_retries: Maximum retry attempts on failure
        """
        self.name = name or self.__class__.__name__
        self.max_retries = max_retries
        self.logger = logger.getChild(self.name)

    @abstractmethod
    async def analyze(self, ticker: str, **kwargs) -> Optional[Any]:
        """Analyze investment.

        Must be implemented by subclasses.

        Args:
            ticker: Investment ticker/symbol
            **kwargs: Agent-specific parameters

        Returns:
            Analysis result or None on failure
        """
        pass

    def log_start(self, ticker: str, phase: str = "analysis"):
        """Log start of analysis."""
        self.logger.info(f"Starting {phase} for {ticker}")

    def log_result(self, ticker: str, result: Any, duration_ms: float):
        """Log successful result."""
        self.logger.info(f"Completed {ticker} in {duration_ms:.0f}ms: {result}")

    def log_error(self, ticker: str, error: Exception, attempt: int):
        """Log error with retry info."""
        self.logger.warning(
            f"Error analyzing {ticker} (attempt {attempt}/{self.max_retries}): {error}"
        )

    async def safe_analyze(self, ticker: str, **kwargs) -> Optional[Any]:
        """Safely analyze with error handling and logging.

        Use this wrapper instead of analyze() directly to get automatic
        logging and error handling.

        Args:
            ticker: Investment ticker/symbol
            **kwargs: Agent-specific parameters

        Returns:
            Analysis result or None on failure
        """
        start_time = datetime.now()
        self.log_start(ticker)

        try:
            result = await self.analyze(ticker, **kwargs)
            duration_ms = (datetime.now() - start_time).total_seconds() * 1000
            self.log_result(ticker, result, duration_ms)
            return result
        except Exception as e:
            duration_ms = (datetime.now() - start_time).total_seconds() * 1000
            self.logger.error(
                f"Failed analyzing {ticker} after {duration_ms:.0f}ms: {e}",
                exc_info=True,
            )
            return None


class ThrottledAPIAgent(BaseAgent):
    """Base agent for API calls with throttling to respect rate limits.

    Tracks API call count and implements backoff when approaching quota.
    """

    def __init__(
        self,
        name: str = None,
        max_calls_per_minute: int = 60,
        warn_threshold: float = 0.8,
        **kwargs,
    ):
        """Initialize throttled API agent.

        Args:
            name: Agent name
            max_calls_per_minute: Rate limit per minute
            warn_threshold: Warn when this % of quota used (0-1)
            **kwargs: Passed to BaseAgent
        """
        super().__init__(name, **kwargs)
        self.max_calls_per_minute = max_calls_per_minute
        self.warn_threshold = warn_threshold
        self.call_count = 0
        self.last_reset = datetime.now()

    async def check_rate_limit(self):
        """Check and enforce rate limiting.

        Sleeps if necessary to stay within quota.
        """
        now = datetime.now()
        elapsed = (now - self.last_reset).total_seconds()

        # Reset counter every minute
        if elapsed >= 60:
            self.call_count = 0
            self.last_reset = now
            return

        self.call_count += 1

        # Check if approaching limit
        usage_ratio = self.call_count / self.max_calls_per_minute
        if usage_ratio > self.warn_threshold:
            self.logger.warning(
                f"Approaching rate limit: {self.call_count}/{self.max_calls_per_minute} "
                f"calls/min ({usage_ratio:.0%})"
            )

        if self.call_count >= self.max_calls_per_minute:
            sleep_time = 60 - elapsed
            self.logger.info(f"Rate limit reached. Sleeping {sleep_time:.1f}s...")
            await asyncio.sleep(sleep_time)
            self.call_count = 0
            self.last_reset = datetime.now()

    async def throttled_call(
        self, coro: Awaitable[T], description: str = ""
    ) -> Optional[T]:
        """Execute API call with rate limiting.

        Args:
            coro: Coroutine to execute
            description: Description for logging

        Returns:
            Result or None on rate limit
        """
        await self.check_rate_limit()
        try:
            return await coro
        except APIError as e:
            self.logger.error(f"API call failed {description}: {e}")
            return None
