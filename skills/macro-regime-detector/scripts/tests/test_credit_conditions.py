"""Tests for Credit Conditions Calculator (HYG/LQD)"""

from calculators.credit_conditions_calculator import calculate_credit_conditions
from test_helpers import make_monthly_history


class TestCalculateCreditConditions:
    def test_insufficient_data_empty(self):
        result = calculate_credit_conditions([], [])
        assert result["score"] == 0
        assert result["data_available"] is False

    def test_stable_ratio_low_score(self):
        hyg = make_monthly_history([75] * 24, start_year=2024)
        lqd = make_monthly_history([105] * 24, start_year=2024)
        result = calculate_credit_conditions(hyg, lqd)
        assert result["data_available"] is True
        assert result["score"] <= 30  # Small noise from daily variation is expected

    def test_easing_conditions(self):
        # HYG rising relative to LQD = easing
        hyg_closes = [70 + i * 0.5 for i in range(24)]
        lqd_closes = [105] * 24
        hyg = make_monthly_history(hyg_closes, start_year=2024)
        lqd = make_monthly_history(lqd_closes, start_year=2024)
        result = calculate_credit_conditions(hyg, lqd)
        assert result["data_available"] is True

    def test_tightening_conditions(self):
        # HYG falling relative to LQD = tightening
        hyg_closes = [80 - i * 0.5 for i in range(24)]
        lqd_closes = [105] * 24
        hyg = make_monthly_history(hyg_closes, start_year=2024)
        lqd = make_monthly_history(lqd_closes, start_year=2024)
        result = calculate_credit_conditions(hyg, lqd)
        assert result["data_available"] is True

    def test_output_structure(self):
        hyg = make_monthly_history([75 + i * 0.1 for i in range(24)], start_year=2024)
        lqd = make_monthly_history([105] * 24, start_year=2024)
        result = calculate_credit_conditions(hyg, lqd)

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
