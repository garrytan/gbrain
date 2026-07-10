"""Tests for Size Factor Calculator (IWM/SPY)"""

from calculators.size_factor_calculator import calculate_size_factor
from test_helpers import make_monthly_history


class TestCalculateSizeFactor:
    def test_insufficient_data_empty(self):
        result = calculate_size_factor([], [])
        assert result["score"] == 0
        assert result["data_available"] is False

    def test_stable_ratio_low_score(self):
        iwm = make_monthly_history([200] * 24, start_year=2024)
        spy = make_monthly_history([500] * 24, start_year=2024)
        result = calculate_size_factor(iwm, spy)
        assert result["data_available"] is True
        assert result["score"] <= 30  # Small noise from daily variation is expected

    def test_small_cap_outperformance(self):
        # IWM rising faster = small cap leading
        iwm_closes = [200 + i * 3 for i in range(24)]
        spy_closes = [500 + i * 1 for i in range(24)]
        iwm = make_monthly_history(iwm_closes, start_year=2024)
        spy = make_monthly_history(spy_closes, start_year=2024)
        result = calculate_size_factor(iwm, spy)
        assert result["data_available"] is True

    def test_large_cap_outperformance(self):
        # SPY rising faster = large cap leading
        iwm_closes = [200 + i * 0.5 for i in range(24)]
        spy_closes = [500 + i * 5 for i in range(24)]
        iwm = make_monthly_history(iwm_closes, start_year=2024)
        spy = make_monthly_history(spy_closes, start_year=2024)
        result = calculate_size_factor(iwm, spy)
        assert result["data_available"] is True

    def test_output_structure(self):
        iwm = make_monthly_history([200 + i for i in range(24)], start_year=2024)
        spy = make_monthly_history([500] * 24, start_year=2024)
        result = calculate_size_factor(iwm, spy)

        required_keys = [
            "score",
            "signal",
            "data_available",
            "direction",
            "current_ratio",
            "sma_6m",
            "sma_12m",
            "roc_3m",
            "roc_12m",
            "percentile",
            "crossover",
            "monthly_points",
        ]
        for key in required_keys:
            assert key in result
        assert 0 <= result["score"] <= 100
