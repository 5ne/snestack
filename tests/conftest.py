"""
Pytest configuration and shared fixtures for fstack tests.
"""

import pytest


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers", "optional: mark test as optional (flaky/skip on failure)"
    )


@pytest.fixture(scope="session")
def pytest_collection_modifyitems(config, items):
    """Modify test collection based on markers."""
    # This allows pytest to respect @pytest.mark.optional without warnings
    pass
