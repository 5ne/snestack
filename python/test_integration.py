"""Integration tests for fstack database operations."""

import pytest
from datetime import datetime

from fstack.core.db import Database


@pytest.mark.integration
class TestDatabase:
    """Test SQLite database CRUD operations."""

    def test_database_creation(self, db):
        assert db.db_path.exists()

    def test_add_and_get_position(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        assert db.add_position("NVDA", 100, 850.0, notes="core holding")

        pos = db.get_position("NVDA")
        assert pos is not None
        assert pos["ticker"] == "NVDA"
        assert pos["shares"] == 100
        assert pos["cost_basis"] == 850.0

    def test_add_and_get_watchlist(self, db):
        db.add_ticker("TSLA", "Tesla", "PUBLIC")
        assert db.add_watchlist("TSLA", "waiting for dip", notes="watch earnings")

        wl = db.get_watchlist()
        assert len(wl) == 1
        assert wl[0]["ticker"] == "TSLA"
        assert wl[0]["thesis"] == "waiting for dip"

    def test_add_and_get_quote(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        today = datetime.now().date().isoformat()
        assert db.add_quote("NVDA", today, 900.0, 910.0, 895.0, 905.0, 45_000_000, rsi=65.0, ma_50=900.0, ma_200=850.0)

        quotes = db.get_quotes("NVDA")
        assert len(quotes) == 1
        assert quotes[0]["close"] == 905.0
        assert quotes[0]["rsi"] == 65.0

    def test_add_and_get_signal(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        signal_id = db.add_signal("NVDA", datetime.now().isoformat(), "BUY", 0.85, "Strong setup", False)
        assert signal_id > 0

        signals = db.get_signals("NVDA")
        assert len(signals) >= 1
        assert signals[0]["recommendation"] == "BUY"
        assert signals[0]["confidence"] == 0.85

    def test_add_and_remove_pending_notification(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        signal_id = db.add_signal("NVDA", datetime.now().isoformat(), "BUY", 0.85, "Test", False)

        assert db.add_pending_notification("NVDA", signal_id, email="test@example.com", notification_type="email")

        pending = db.get_pending_notifications()
        assert len(pending) == 1
        assert pending[0]["ticker"] == "NVDA"

        assert db.remove_pending_notification(pending[0]["id"])
        assert len(db.get_pending_notifications()) == 0

    def test_position_upsert(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        db.add_position("NVDA", 100, 850.0)
        db.add_position("NVDA", 200, 900.0)

        pos = db.get_position("NVDA")
        assert pos["shares"] == 200
        assert pos["cost_basis"] == 900.0

    def test_get_latest_quote(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        db.add_quote("NVDA", "2026-05-01", 900, 910, 895, 905, 1_000_000)
        db.add_quote("NVDA", "2026-05-02", 905, 915, 900, 910, 1_100_000)

        latest = db.get_latest_quote("NVDA")
        assert latest["date"] == "2026-05-02"

    def test_quote_history_ordering(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        for i, date in enumerate(["2026-05-22", "2026-05-23", "2026-05-24"]):
            db.add_quote("NVDA", date, 900 + i, 910 + i, 895 + i, 905 + i, 45_000_000)

        quotes = db.get_quotes("NVDA")
        assert len(quotes) == 3
        assert quotes[0]["date"] >= quotes[1]["date"]

    def test_retry_count_update(self, db):
        db.add_ticker("NVDA", "NVIDIA", "PUBLIC")
        signal_id = db.add_signal("NVDA", datetime.now().isoformat(), "HOLD", 0.5, "Test", False)
        db.add_pending_notification("NVDA", signal_id, email="x@example.com", notification_type="email")

        pending = db.get_pending_notifications()
        nid = pending[0]["id"]
        assert pending[0]["retry_count"] == 0

        db.update_pending_notification_retry(nid)
        updated = db.get_pending_notifications()
        assert updated[0]["retry_count"] == 1


@pytest.mark.integration
class TestModelValidation:
    """Pydantic model validation."""

    def test_position_rejects_negative_shares(self):
        from fstack.core.models import Position
        with pytest.raises(Exception):
            Position(ticker="NVDA", shares=-100, cost_basis=850.0, entry_date=datetime.now())

    def test_quote_rejects_close_above_high(self):
        from fstack.core.models import Quote
        with pytest.raises(Exception):
            Quote(ticker="NVDA", date=datetime.now(), open=900, high=910, low=895, close=920, volume=1000)

    def test_signal_recommendation_literal(self):
        from fstack.core.models import Signal
        with pytest.raises(Exception):
            Signal(ticker="NVDA", recommendation="MAYBE", confidence=0.5, reasoning="test")

    def test_equity_data_morningstar_fields(self):
        from fstack.core.models import EquityData
        eq = EquityData(
            ticker="NVDA",
            pe_ratio=32.33,
            fair_value=280.0,
            price_to_fair_value=0.75,
            economic_moat="Wide",
            morningstar_rating=4,
            uncertainty="Very High",
            capital_allocation="Exemplary",
        )
        assert eq.fair_value == 280.0
        assert eq.economic_moat == "Wide"
        assert eq.morningstar_rating == 4
