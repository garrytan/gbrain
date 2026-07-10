"""Shared fixtures for market-breadth-analyzer tests."""

import os
import sys

import pytest

# Ensure scripts/ is on sys.path so calculators and scorer can be imported.
SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


@pytest.fixture
def make_row():
    """Return a factory that creates a single mock detail row.

    Usage::

        row = make_row(Date="2025-01-10", Breadth_Index_8MA=0.55)
    """

    def _factory(**overrides):
        defaults = {
            "Date": "2025-01-01",
            "S&P500_Price": 5000.0,
            "Breadth_Index_Raw": 0.50,
            "Breadth_Index_200MA": 0.50,
            "Breadth_Index_8MA": 0.50,
            "Breadth_200MA_Trend": 1,
            "Bearish_Signal": False,
            "Is_Peak": False,
            "Is_Trough": False,
            "Is_Trough_8MA_Below_04": False,
        }
        defaults.update(overrides)
        return defaults

    return _factory


@pytest.fixture
def make_rows(make_row):
    """Return a factory that creates *n* rows with sequential dates.

    Usage::

        rows = make_rows(10, Breadth_Index_8MA=0.55)

    The ``Date`` field is auto-generated as ``2025-01-01``, ``2025-01-02``, ...
    Individual overrides per-row are not supported; use ``make_row`` directly.
    """

    def _factory(n, **overrides):
        rows = []
        for i in range(n):
            day = f"2025-01-{i + 1:02d}"
            rows.append(make_row(Date=day, **overrides))
        return rows

    return _factory
