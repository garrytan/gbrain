"""Tests for Component 2: MA Crossover Calculator."""

from calculators.ma_crossover_calculator import calculate_ma_crossover


def _make_crossover_rows(make_row, n=10, ma8=0.60, ma200=0.50, ma8_5d_ago=None):
    """Create n rows. The 5th-from-last sets ma8_5d_ago value."""
    if ma8_5d_ago is None:
        ma8_5d_ago = ma8  # no direction change
    rows = []
    for i in range(n):
        if i == n - 6:
            rows.append(
                make_row(
                    Date=f"2025-01-{i + 1:02d}",
                    Breadth_Index_8MA=ma8_5d_ago,
                    Breadth_Index_200MA=ma200,
                )
            )
        else:
            rows.append(
                make_row(
                    Date=f"2025-01-{i + 1:02d}",
                    Breadth_Index_8MA=ma8,
                    Breadth_Index_200MA=ma200,
                )
            )
    return rows


class TestInsufficientData:
    def test_fewer_than_6_rows(self, make_row):
        rows = [make_row() for _ in range(5)]
        result = calculate_ma_crossover(rows)
        assert result["data_available"] is False
        assert result["score"] == 50

    def test_empty_rows(self):
        result = calculate_ma_crossover([])
        assert result["data_available"] is False


class TestGapScoring:
    """Gap = 8MA - 200MA determines base score."""

    def test_large_positive_gap(self, make_row):
        rows = _make_crossover_rows(make_row, ma8=0.70, ma200=0.50)
        result = calculate_ma_crossover(rows)
        assert result["gap_score"] == 95  # gap=0.20 >= 0.15

    def test_moderate_positive_gap(self, make_row):
        rows = _make_crossover_rows(make_row, ma8=0.62, ma200=0.50)
        result = calculate_ma_crossover(rows)
        assert result["gap_score"] == 80  # gap=0.12 >= 0.10

    def test_small_positive_gap(self, make_row):
        rows = _make_crossover_rows(make_row, ma8=0.56, ma200=0.50)
        result = calculate_ma_crossover(rows)
        assert result["gap_score"] == 65  # gap=0.06 >= 0.05

    def test_zero_gap(self, make_row):
        rows = _make_crossover_rows(make_row, ma8=0.50, ma200=0.50)
        result = calculate_ma_crossover(rows)
        assert result["gap_score"] == 50  # gap=0.00

    def test_small_negative_gap(self, make_row):
        rows = _make_crossover_rows(make_row, ma8=0.47, ma200=0.50)
        result = calculate_ma_crossover(rows)
        assert result["gap_score"] == 35  # gap=-0.03 >= -0.05

    def test_large_negative_gap(self, make_row):
        rows = _make_crossover_rows(make_row, ma8=0.35, ma200=0.50)
        result = calculate_ma_crossover(rows)
        assert result["gap_score"] == 5  # gap=-0.15 < -0.10


class TestDirectionModifier:
    """8MA direction modifier based on 5-day lookback."""

    def test_recovery_signal_plus10(self, make_row):
        # Gap < 0 (8MA below 200MA) but 8MA rising -> +10
        rows = _make_crossover_rows(
            make_row,
            ma8=0.48,
            ma200=0.50,
            ma8_5d_ago=0.44,
        )
        result = calculate_ma_crossover(rows)
        assert result["direction_modifier"] == 10
        assert result["ma8_direction"] == "rising"

    def test_deterioration_signal_minus10(self, make_row):
        # Gap > 0 (8MA above 200MA) but 8MA falling -> -10
        rows = _make_crossover_rows(
            make_row,
            ma8=0.55,
            ma200=0.50,
            ma8_5d_ago=0.60,
        )
        result = calculate_ma_crossover(rows)
        assert result["direction_modifier"] == -10
        assert result["ma8_direction"] == "falling"

    def test_no_modifier_gap_positive_rising(self, make_row):
        # Gap > 0 and rising -> no modifier (healthy)
        rows = _make_crossover_rows(
            make_row,
            ma8=0.60,
            ma200=0.50,
            ma8_5d_ago=0.55,
        )
        result = calculate_ma_crossover(rows)
        assert result["direction_modifier"] == 0

    def test_no_modifier_gap_negative_falling(self, make_row):
        # Gap < 0 and falling -> no modifier (already bearish)
        rows = _make_crossover_rows(
            make_row,
            ma8=0.45,
            ma200=0.50,
            ma8_5d_ago=0.48,
        )
        result = calculate_ma_crossover(rows)
        assert result["direction_modifier"] == 0


class TestScoreClamping:
    def test_score_clamped_0_to_100(self, make_row):
        rows = _make_crossover_rows(make_row, ma8=0.70, ma200=0.50)
        result = calculate_ma_crossover(rows)
        assert 0 <= result["score"] <= 100
