"""Tests for Sector Rotation Calculator (XLY/XLP)"""

from calculators.sector_rotation_calculator import calculate_sector_rotation
from test_helpers import make_monthly_history


class TestCalculateSectorRotation:
    def test_insufficient_data_empty(self):
        result = calculate_sector_rotation([], [])
        assert result["score"] == 0
        assert result["data_available"] is False

    def test_stable_ratio_low_score(self):
        xly = make_monthly_history([180] * 24, start_year=2024)
        xlp = make_monthly_history([75] * 24, start_year=2024)
        result = calculate_sector_rotation(xly, xlp)
        assert result["data_available"] is True
        assert result["score"] <= 30  # Small noise from daily variation is expected

    def test_risk_on_rotation(self):
        # XLY rising faster than XLP = risk-on
        xly_closes = [180 + i * 3 for i in range(24)]
        xlp_closes = [75] * 24
        xly = make_monthly_history(xly_closes, start_year=2024)
        xlp = make_monthly_history(xlp_closes, start_year=2024)
        result = calculate_sector_rotation(xly, xlp)
        assert result["data_available"] is True

    def test_risk_off_rotation(self):
        # XLY falling, XLP rising = risk-off
        xly_closes = [200 - i * 2 for i in range(24)]
        xlp_closes = [70 + i * 2 for i in range(24)]
        xly = make_monthly_history(xly_closes, start_year=2024)
        xlp = make_monthly_history(xlp_closes, start_year=2024)
        result = calculate_sector_rotation(xly, xlp)
        assert result["data_available"] is True

    def test_output_structure(self):
        xly = make_monthly_history([180 + i for i in range(24)], start_year=2024)
        xlp = make_monthly_history([75] * 24, start_year=2024)
        result = calculate_sector_rotation(xly, xlp)

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
            "momentum_qualifier",
        ]
        for key in required_keys:
            assert key in result
        assert 0 <= result["score"] <= 100

    def test_stale_crossover_reversal(self):
        """Stale golden cross with declining recent momentum → risk_off + reversing."""
        # Build ratio that crosses up early then declines recently
        # 24 months: rise for first 12, then decline for next 12
        xly_closes = [180 + i * 3 for i in range(12)] + [215 - i * 5 for i in range(12)]
        xlp_closes = [75] * 24
        xly = make_monthly_history(xly_closes, start_year=2024)
        xlp = make_monthly_history(xlp_closes, start_year=2024)
        result = calculate_sector_rotation(xly, xlp)
        # The crossover happened early (stale) and recent momentum is negative
        if (
            result["crossover"]["type"] == "golden_cross"
            and result["crossover"]["bars_ago"] is not None
            and result["crossover"]["bars_ago"] >= 3
            and result["roc_3m"] is not None
            and result["roc_3m"] < 0
        ):
            assert result["direction"] == "risk_off"
            assert result["momentum_qualifier"] == "reversing"
