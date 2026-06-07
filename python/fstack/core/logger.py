"""Structured logging for fstack."""

import logging
import json
from datetime import datetime
from pathlib import Path

# Create logs directory
LOGS_DIR = Path.cwd() / "logs"
LOGS_DIR.mkdir(exist_ok=True)


class StructuredFormatter(logging.Formatter):
    """Formatter that outputs structured JSON logs."""

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON."""
        log_data = {
            "timestamp": datetime.fromtimestamp(record.created).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Add extra fields
        if hasattr(record, "ticker"):
            log_data["ticker"] = record.ticker
        if hasattr(record, "duration_ms"):
            log_data["duration_ms"] = record.duration_ms
        if hasattr(record, "status"):
            log_data["status"] = record.status

        # Add exception info
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_data)


def setup_logging(level: str = "INFO", log_file: bool = True) -> None:
    """Setup logging for fstack.

    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR)
        log_file: Whether to log to file
    """
    # Root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Remove existing handlers
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    # Console handler (simple format)
    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_formatter = logging.Formatter(
        "%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    console_handler.setFormatter(console_formatter)
    root_logger.addHandler(console_handler)

    # File handler (JSON format)
    if log_file:
        log_path = LOGS_DIR / f"fstack-{datetime.now().strftime('%Y%m%d')}.log"
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setLevel(level)
        file_formatter = StructuredFormatter()
        file_handler.setFormatter(file_formatter)
        root_logger.addHandler(file_handler)


def log_analysis_start(logger: logging.Logger, ticker: str) -> None:
    """Log start of ticker analysis."""
    logger.info(f"Starting analysis for {ticker}")


def log_analysis_result(
    logger: logging.Logger,
    ticker: str,
    recommendation: str,
    confidence: float,
    duration_ms: float,
) -> None:
    """Log successful analysis result."""
    logger.info(
        f"Completed analysis: {ticker} {recommendation} ({confidence:.0%})",
        extra={
            "ticker": ticker,
            "recommendation": recommendation,
            "confidence": confidence,
            "duration_ms": duration_ms,
        },
    )


def log_batch_start(logger: logging.Logger, ticker_count: int) -> None:
    """Log start of batch analysis."""
    logger.info(f"Starting batch analysis for {ticker_count} tickers")


def log_batch_complete(
    logger: logging.Logger,
    signal_count: int,
    error_count: int,
    duration_s: float,
) -> None:
    """Log completion of batch analysis."""
    logger.info(
        f"Batch analysis complete: {signal_count} signals, {error_count} errors, {duration_s:.1f}s",
        extra={
            "signal_count": signal_count,
            "error_count": error_count,
            "duration_s": duration_s,
        },
    )


def log_email_sent(logger: logging.Logger, recipient: str, signal_count: int) -> None:
    """Log email notification sent."""
    logger.info(
        f"Email sent to {recipient} with {signal_count} signals",
        extra={"recipient": recipient, "signal_count": signal_count},
    )


def log_email_failed(logger: logging.Logger, recipient: str, error: str) -> None:
    """Log failed email notification."""
    logger.warning(
        f"Email send failed to {recipient}: {error}",
        extra={"recipient": recipient, "error": error},
    )
