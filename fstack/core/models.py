"""Data models for fstack using Pydantic v2.

Defines Signal, Position, Quote, Watchlist, Ticker, and other data structures.
"""

from datetime import datetime
from typing import Optional, Literal
from pydantic import BaseModel, Field, field_validator


class Ticker(BaseModel):
    """Master ticker/investment record."""

    symbol: str = Field(..., description="Ticker symbol (e.g., NVDA, anthropic)")
    name: str = Field(..., description="Company name")
    type: Literal["PUBLIC", "PRIVATE"] = Field(..., description="PUBLIC or PRIVATE")
    sector: Optional[str] = Field(None, description="Industry sector")
    added_date: datetime = Field(default_factory=datetime.now)
    notes: Optional[str] = None

    class Config:
        json_schema_extra = {
            "example": {
                "symbol": "NVDA",
                "name": "NVIDIA Corporation",
                "type": "PUBLIC",
                "sector": "Technology",
            }
        }


class Position(BaseModel):
    """Current portfolio position."""

    ticker: str = Field(..., description="Ticker symbol")
    shares: float = Field(..., gt=0, description="Number of shares")
    cost_basis: float = Field(..., gt=0, description="Average cost per share")
    entry_date: datetime = Field(..., description="Date position was opened")
    notes: Optional[str] = None

    class Config:
        json_schema_extra = {
            "example": {
                "ticker": "NVDA",
                "shares": 100,
                "cost_basis": 850.0,
                "entry_date": "2024-01-15T00:00:00Z",
            }
        }


class Watchlist(BaseModel):
    """Watchlist investment (not yet in portfolio)."""

    ticker: str = Field(..., description="Ticker symbol")
    thesis: str = Field(..., description="Investment thesis/reason for watching")
    added_date: datetime = Field(default_factory=datetime.now)
    notes: Optional[str] = None

    class Config:
        json_schema_extra = {
            "example": {
                "ticker": "TSLA",
                "thesis": "Looking for entry after earnings correction",
            }
        }


class Quote(BaseModel):
    """Historical price data for a ticker on a specific date."""

    ticker: str = Field(..., description="Ticker symbol")
    date: datetime = Field(..., description="Quote date")
    open: float = Field(..., description="Opening price")
    high: float = Field(..., description="Day high")
    low: float = Field(..., description="Day low")
    close: float = Field(..., description="Closing price")
    volume: int = Field(..., ge=0, description="Trading volume")
    rsi: Optional[float] = Field(None, ge=0, le=100, description="RSI indicator")
    ma_50: Optional[float] = Field(None, description="50-day moving average")
    ma_200: Optional[float] = Field(None, description="200-day moving average")

    @field_validator("close")
    @classmethod
    def close_within_high_low(cls, v, info):
        """Validate close price is between high and low."""
        if "high" in info.data and "low" in info.data:
            high = info.data["high"]
            low = info.data["low"]
            if not (low <= v <= high):
                raise ValueError(f"close {v} must be between low {low} and high {high}")
        return v

    class Config:
        json_schema_extra = {
            "example": {
                "ticker": "NVDA",
                "date": "2024-05-24T00:00:00Z",
                "open": 900.0,
                "high": 910.0,
                "low": 895.0,
                "close": 905.0,
                "volume": 45000000,
                "rsi": 65,
                "ma_50": 900.0,
                "ma_200": 850.0,
            }
        }


class Signal(BaseModel):
    """Analysis recommendation from an agent or orchestrator."""

    ticker: str = Field(..., description="Ticker symbol")
    date: datetime = Field(default_factory=datetime.now)
    recommendation: Literal["BUY", "SELL", "HOLD"] = Field(
        ..., description="Investment recommendation"
    )
    confidence: float = Field(
        ..., ge=0.0, le=1.0, description="Confidence level 0-1"
    )
    reasoning: str = Field(..., description="Explanation for recommendation")
    from_watchlist: bool = Field(
        default=False, description="Whether this is from watchlist or positions"
    )
    created_at: datetime = Field(default_factory=datetime.now)
    signal_id: Optional[int] = Field(None, description="Database signal ID")

    class Config:
        json_schema_extra = {
            "example": {
                "ticker": "NVDA",
                "recommendation": "BUY",
                "confidence": 0.85,
                "reasoning": "Strong earnings growth, AI leadership position, reasonable valuation",
                "from_watchlist": False,
            }
        }


class PendingNotification(BaseModel):
    """Failed notification queued for retry."""

    id: Optional[int] = None
    ticker: str = Field(..., description="Ticker symbol")
    signal_id: Optional[int] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    notification_type: Literal["email", "sms"] = Field(
        ..., description="Notification channel"
    )
    created_at: datetime = Field(default_factory=datetime.now)
    retry_count: int = Field(default=0, ge=0)
    last_retry_at: Optional[datetime] = None

    class Config:
        json_schema_extra = {
            "example": {
                "ticker": "NVDA",
                "email": "user@example.com",
                "notification_type": "email",
                "retry_count": 1,
            }
        }


class QuoteData(BaseModel):
    """Raw quote data from API."""

    ticker: str
    price: float
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    volume: Optional[int] = None
    timestamp: datetime = Field(default_factory=datetime.now)


class EquityData(BaseModel):
    """Fundamental equity data from API."""

    ticker: str
    pe_ratio: Optional[float] = None
    pb_ratio: Optional[float] = None
    debt_to_equity: Optional[float] = None
    fcf: Optional[float] = None
    fcf_yield: Optional[float] = None
    dividend_yield: Optional[float] = None
    earnings_growth: Optional[float] = None
    revenue_growth: Optional[float] = None
    red_flags: list[str] = Field(default_factory=list, description="Warning signs detected")
    timestamp: datetime = Field(default_factory=datetime.now)


class StrategySignal(BaseModel):
    """Signal from strategy/technical analysis agent."""

    ticker: str
    recommendation: Literal["BUY", "SELL", "HOLD"]
    confidence: float = Field(ge=0.0, le=1.0)
    rsi_signal: Optional[str] = None
    ma_signal: Optional[str] = None
    volume_signal: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.now)


class BatchAnalysisInput(BaseModel):
    """Input for batch analysis orchestration."""

    positions: list[str] = Field(description="Tickers in portfolio")
    watchlist: list[str] = Field(description="Tickers on watchlist")
    max_concurrent: int = Field(default=5, description="Max concurrent agent calls")


class BatchAnalysisResult(BaseModel):
    """Result of batch analysis."""

    signals: list[Signal] = Field(description="All generated signals")
    errors: dict[str, str] = Field(default_factory=dict, description="Ticker -> error mapping")
    start_time: datetime
    end_time: datetime
    duration_seconds: float = Field(description="Total execution time")

    @property
    def success_count(self) -> int:
        """Number of successful analyses."""
        return len(self.signals)

    @property
    def error_count(self) -> int:
        """Number of failed analyses."""
        return len(self.errors)
