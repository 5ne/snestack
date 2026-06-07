"""Pytest configuration and shared fixtures for fstack tests."""

import pytest
from fstack.core.db import Database


def pytest_configure(config):
    config.addinivalue_line("markers", "optional: mark test as optional (flaky/skip on failure)")
    config.addinivalue_line("markers", "unit: pure unit test, no I/O")
    config.addinivalue_line("markers", "integration: requires DB or filesystem")


@pytest.fixture
def db(tmp_path):
    """In-memory-style Database backed by a temp file."""
    return Database(str(tmp_path / "test.db"))


@pytest.fixture
def db_with_ticker(db):
    """Database pre-loaded with an NVDA ticker row (required by FK constraints)."""
    db.add_ticker("NVDA", "NVIDIA Corporation", "PUBLIC", sector="Technology")
    return db
