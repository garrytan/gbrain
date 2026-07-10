"""Tests for Equity-Bond Relationship Calculator (SPY/TLT + correlation)"""

from calculators.equity_bond_calculator import calculate_equity_bond
from test_helpers import make_monthly_history


class TestCalculateEquityBond:
    def test_insufficient_data_empty(self):
        result = calculate_equity_bond([], [])
        assert result["score"] == 0
        assert result["data_available"] is False

    def test_stable_ratio_low_score(self):
        spy = make_monthly_history([500] * 24, start_year=2024)
        tlt = make_monthly_history([90] * 24, start_year=2024)
        result = calculate_equity_bond(spy, tlt)
        assert result["data_available"] is True
        assert result["score"] <= 30  # Small noise from daily variation is expected

    def test_risk_on_shift(self):
        # SPY rising, TLT flat = risk-on
        spy_closes = [500 + i * 5 for i in range(24)]
        tlt_closes = [90] * 24
        spy = make_monthly_history(spy_closes, start_year=2024)
        tlt = make_monthly_history(tlt_closes, start_year=2024)
        result = calculate_equity_bond(spy, tlt)
        assert result["data_available"] is True

    def test_risk_off_shift(self):
        # SPY falling, TLT rising = risk-off
        spy_closes = [600 - i * 5 for i in range(24)]
        tlt_closes = [80 + i * 2 for i in range(24)]
        spy = make_monthly_history(spy_closes, start_year=2024)
        tlt = make_monthly_history(tlt_closes, start_year=2024)
        result = calculate_equity_bond(spy, tlt)
        assert result["data_available"] is True

    def test_correlation_regime_present(self):
        spy = make_monthly_history([500 + i * 2 for i in range(24)], start_year=2024)
        tlt = make_monthly_history([90 - i * 0.5 for i in range(24)], start_year=2024)
        result = calculate_equity_bond(spy, tlt)
        assert result["correlation_regime"] in (
            "negative_strong",
            "negative_mild",
            "near_zero",
            "positive",
            "unknown",
        )

    def test_output_structure(self):
        spy = make_monthly_history([500 + i for i in range(24)], start_year=2024)
        tlt = make_monthly_history([90] * 24, start_year=2024)
        result = calculate_equity_bond(spy, tlt)

        required_keys = [
            "score",
            "signal",
            "data_available",
            "direction",
            "correlation_regime",
            "current_ratio",
            "sma_6m",
            "sma_12m",
            "roc_3m",
            "roc_12m",
            "percentile",
            "correlation_6m",
            "correlation_12m",
            "crossover",
            "monthly_points",
        ]
        for key in required_keys:
            assert key in result
        assert 0 <= result["score"] <= 100
