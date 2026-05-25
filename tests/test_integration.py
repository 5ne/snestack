"""Integration tests for fstack database and analysis flow."""

import pytest
import sqlite3
from pathlib import Path
from datetime import datetime

from fstack.core.db import Database
from fstack.core.models import Position, Watchlist, Quote, Signal


@pytest.fixture
def test_db(tmp_path):
    """Create test database."""
    db_path = tmp_path / "test.db"
    db = Database(str(db_path))
    return db


class TestDatabase:
    """Test SQLite database operations."""

    def test_database_creation(self, test_db):
        """Database file is created with schema."""
        assert test_db.db_path.exists()

    def test_add_position(self, test_db):
        """Add position to database."""
        success = test_db.add_position(
            ticker="NVDA",
            shares=100,
            cost_basis=850.0,
            notes="core holding",
        )
        assert success

        position = test_db.get_position("NVDA")
        assert position is not None
        assert position["ticker"] == "NVDA"
        assert position["shares"] == 100
        assert position["cost_basis"] == 850.0

    def test_add_watchlist(self, test_db):
        """Add to watchlist."""
        success = test_db.add_watchlist(
            ticker="TSLA",
            thesis="waiting for dip",
            notes="watch for earnings",
        )
        assert success

        watchlist = test_db.get_watchlist()
        assert len(watchlist) == 1
        assert watchlist[0]["ticker"] == "TSLA"
        assert watchlist[0]["thesis"] == "waiting for dip"

    def test_add_quote(self, test_db):
        """Add price quote."""
        today = datetime.now().date().isoformat()
        success = test_db.add_quote(
            ticker="NVDA",
            date=today,
            open_=900.0,
            high=910.0,
            low=895.0,
            close=905.0,
            volume=45000000,
            rsi=65.0,
            ma_50=900.0,
            ma_200=850.0,
        )
        assert success

        quotes = test_db.get_quotes("NVDA")
        assert len(quotes) == 1
        assert quotes[0]["close"] == 905.0
        assert quotes[0]["rsi"] == 65.0

    def test_add_signal(self, test_db):
        """Add analysis signal."""
        signal_id = test_db.add_signal(
            ticker="NVDA",
            date=datetime.now().isoformat(),
            recommendation="BUY",
            confidence=0.85,
            reasoning="Strong technical + fundamental setup",
            from_watchlist=False,
        )
        assert signal_id > 0

        signals = test_db.get_signals("NVDA")
        assert len(signals) == 1
        assert signals[0]["recommendation"] == "BUY"
        assert signals[0]["confidence"] == 0.85

    def test_add_pending_notification(self, test_db):
        """Add pending email notification."""
        signal_id = test_db.add_signal(
            ticker="NVDA",
            date=datetime.now().isoformat(),
            recommendation="BUY",
            confidence=0.85,
            reasoning="Test",
            from_watchlist=False,
        )

        success = test_db.add_pending_notification(
            ticker="NVDA",
            signal_id=signal_id,
            email="test@example.com",
            notification_type="email",
        )
        assert success

        pending = test_db.get_pending_notifications()
        assert len(pending) == 1
        assert pending[0]["ticker"] == "NVDA"
        assert pending[0]["email"] == "test@example.com"

    def test_remove_pending_notification(self, test_db):
        """Remove pending notification."""
        signal_id = test_db.add_signal(
            ticker="NVDA",
            date=datetime.now().isoformat(),
            recommendation="BUY",
            confidence=0.85,
            reasoning="Test",
            from_watchlist=False,
        )

        test_db.add_pending_notification(
            ticker="NVDA",
            signal_id=signal_id,
            email="test@example.com",
            notification_type="email",
        )

        pending = test_db.get_pending_notifications()
        assert len(pending) == 1

        success = test_db.remove_pending_notification(pending[0]["id"])
        assert success

        pending = test_db.get_pending_notifications()
        assert len(pending) == 0

    def test_unique_positions_constraint(self, test_db):
        """Positions are unique by ticker."""
        test_db.add_position("NVDA", 100, 850.0)
        success = test_db.add_position("NVDA", 200, 900.0)

        # Second add should replace (INSERT OR REPLACE)
        assert success
        position = test_db.get_position("NVDA")
        assert position["shares"] == 200
        assert position["cost_basis"] == 900.0


class TestDataFlow:
    """Test complete data flow from quotes to signals."""

    def test_batch_data_flow(self, test_db):
        """Complete flow: positions → quotes → signals."""
        # Add positions
        test_db.add_position("NVDA", 100, 850.0)
        test_db.add_position("TSLA", 50, 250.0)
        test_db.add_watchlist("AAPL", "waiting for dip")

        # Add quotes
        today = datetime.now().date().isoformat()
        test_db.add_quote("NVDA", today, 900, 910, 895, 905, 45000000, rsi=65, ma_50=900, ma_200=850)
        test_db.add_quote("TSLA", today, 250, 260, 245, 255, 100000000, rsi=55, ma_50=250, ma_200=240)
        test_db.add_quote("AAPL", today, 180, 185, 175, 182, 50000000, rsi=60, ma_50=180, ma_200=170)

        # Verify positions
        positions = test_db.get_all_positions()
        assert len(positions) == 2

        # Verify watchlist
        watchlist = test_db.get_watchlist()
        assert len(watchlist) == 1

        # Verify quotes
        nvda_quotes = test_db.get_quotes("NVDA")
        assert len(nvda_quotes) == 1
        assert nvda_quotes[0]["close"] == 905

        # Add signals
        test_db.add_signal("NVDA", today, "BUY", 0.85, "Strong setup", False)
        test_db.add_signal("TSLA", today, "HOLD", 0.5, "Neutral", False)
        test_db.add_signal("AAPL", today, "SELL", 0.7, "Overbought", True)

        # Verify signals
        nvda_signals = test_db.get_signals("NVDA")
        assert len(nvda_signals) == 1
        assert nvda_signals[0]["recommendation"] == "BUY"

    def test_signal_history(self, test_db):
        """Maintain signal history for same ticker."""
        today = datetime.now().date().isoformat()

        # Add multiple signals for same ticker
        test_db.add_signal("NVDA", today, "BUY", 0.85, "Signal 1", False)
        test_db.add_signal("NVDA", today, "HOLD", 0.5, "Signal 2", False)
        test_db.add_signal("NVDA", today, "SELL", 0.7, "Signal 3", False)

        signals = test_db.get_signals("NVDA")
        assert len(signals) == 3

    def test_quote_multiple_dates(self, test_db):
        """Maintain quote history across multiple days."""
        dates = ["2026-05-22", "2026-05-23", "2026-05-24"]

        for i, date in enumerate(dates):
            test_db.add_quote(
                "NVDA",
                date,
                open_=900 + i,
                high=910 + i,
                low=895 + i,
                close=905 + i,
                volume=45000000 + i * 1000000,
            )

        quotes = test_db.get_quotes("NVDA")
        assert len(quotes) >= 3  # Might have more if other tests ran

        # Latest quote should be first (ORDER BY DESC)
        assert quotes[0]["date"] >= quotes[1]["date"]


class TestValidation:
    """Test data validation and constraints."""

    def test_position_constraint_shares_positive(self, test_db):
        """Positions must have positive shares (enforced by Pydantic on insert)."""
        # Database allows it, but model validation prevents bad data
        from fstack.core.models import Position

        with pytest.raises(ValueError):
            Position(
                ticker="NVDA",
                shares=-100,  # Invalid
                cost_basis=850.0,
                entry_date=datetime.now(),
            )

    def test_signal_recommendation_valid(self, test_db):
        """Signal recommendation must be BUY/SELL/HOLD."""
        # Try adding invalid recommendation (SQLite CHECK constraint prevents)
        with pytest.raises(Exception):
            test_db.execute(
                "INSERT INTO signals (ticker, date, recommendation, confidence, reasoning, from_watchlist, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("NVDA", datetime.now().isoformat(), "INVALID", 0.5, "bad", 0, datetime.now().isoformat()),
            )

    def test_quote_close_within_range(self, test_db):
        """Quote close must be within high/low (enforced by Pydantic)."""
        from fstack.core.models import Quote

        with pytest.raises(ValueError):
            Quote(
                ticker="NVDA",
                date=datetime.now(),
                open=900,
                high=910,
                low=895,
                close=920,  # Above high
                volume=1000,
            )
