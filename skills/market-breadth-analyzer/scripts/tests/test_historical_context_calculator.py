"""Tests for Component 5: Historical Context (Percentile) Calculator."""

from calculators.historical_context_calculator import (
    calculate_historical_percentile,
)


def _make_summary(avg_peak="0.729", avg_trough="0.232"):
    """Return a minimal summary dict."""
    return {
        "Average Peaks (200MA)": avg_peak,
        "Average Troughs (8MA < 0.4)": avg_trough,
    }


class TestEmptyData:
    def test_empty_rows_returns_unavailable(self):
        result = calculate_historical_percentile([], _make_summary())
        assert result["score"] == 50
        assert result["data_available"] is False


class TestPercentileScoring:
    """Base score tiers from percentile rank."""

    def test_high_percentile_score_90(self, make_row):
        # 100 rows at 0.40, latest at 0.80 -> percentile near 99
        rows = [make_row(Breadth_Index_8MA=0.40) for _ in range(99)]
        rows.append(make_row(Breadth_Index_8MA=0.80))
        result = calculate_historical_percentile(rows, _make_summary())
        assert result["base_score"] == 90

    def test_mid_percentile_score_50(self, make_row):
        # 50 rows at 0.40, 50 rows at 0.60, latest at 0.50
        rows = [make_row(Breadth_Index_8MA=0.40) for _ in range(50)]
        rows += [make_row(Breadth_Index_8MA=0.60) for _ in range(49)]
        rows.append(make_row(Breadth_Index_8MA=0.50))
        result = calculate_historical_percentile(rows, _make_summary())
        assert result["base_score"] == 50

    def test_low_percentile_score_10(self, make_row):
        # 100 rows at 0.60, latest at 0.20 -> percentile near 0
        rows = [make_row(Breadth_Index_8MA=0.60) for _ in range(99)]
        rows.append(make_row(Breadth_Index_8MA=0.20))
        result = calculate_historical_percentile(rows, _make_summary())
        assert result["base_score"] == 10


class TestExtremeAdjustments:
    """Overheated/oversold adjustments."""

    def test_overheated_adjustment_minus10(self, make_row):
        # current >= avg_peak * 0.95 = 0.729 * 0.95 = 0.6926
        rows = [make_row(Breadth_Index_8MA=0.50) for _ in range(99)]
        rows.append(make_row(Breadth_Index_8MA=0.73))
        result = calculate_historical_percentile(rows, _make_summary())
        assert result["adjustment"] == -10

    def test_oversold_adjustment_plus10(self, make_row):
        # current <= avg_trough * 1.05 = 0.232 * 1.05 = 0.2436
        rows = [make_row(Breadth_Index_8MA=0.50) for _ in range(99)]
        rows.append(make_row(Breadth_Index_8MA=0.23))
        result = calculate_historical_percentile(rows, _make_summary())
        assert result["adjustment"] == 10

    def test_no_adjustment_in_normal_range(self, make_row):
        rows = [make_row(Breadth_Index_8MA=0.50) for _ in range(100)]
        result = calculate_historical_percentile(rows, _make_summary())
        assert result["adjustment"] == 0

    def test_missing_summary_values_no_adjustment(self, make_row):
        rows = [make_row(Breadth_Index_8MA=0.73) for _ in range(100)]
        result = calculate_historical_percentile(rows, {})
        assert result["adjustment"] == 0


class TestOutputFields:
    """Verify all expected output fields are present."""

    def test_output_contains_required_keys(self, make_row):
        rows = [make_row() for _ in range(50)]
        result = calculate_historical_percentile(rows, _make_summary())
        assert result["data_available"] is True
        assert "percentile_rank" in result
        assert "base_score" in result
        assert "avg_peak" in result
        assert "avg_trough" in result
        assert "total_observations" in result
        assert result["total_observations"] == 50
