"""Tests for Component 1: Trend Level Calculator — 8MA direction modifier."""

from calculators.trend_level_calculator import calculate_breadth_level_trend


def _make_direction_rows(make_row, n, ma8_5d_ago, ma8_latest, **kwargs):
    """Create n rows where rows[-6] and rows[-1] have specified 8MA values."""
    rows = [make_row(Breadth_Index_8MA=ma8_latest, **kwargs) for _ in range(n)]
    rows[0]["Breadth_Index_8MA"] = ma8_5d_ago
    return rows


class TestDirectionModifier:
    """8MA direction modifier tests."""

    def test_falling_high_level_penalty(self, make_row):
        """8MA falling from high level (>0.60) -> -10."""
        rows = _make_direction_rows(make_row, 6, ma8_5d_ago=0.72, ma8_latest=0.65)
        result = calculate_breadth_level_trend(rows)
        assert result["ma8_direction"] == "falling"
        assert result["direction_modifier"] == -10

    def test_falling_low_level_bonus(self, make_row):
        """8MA falling at low level (<0.40) -> +5."""
        rows = _make_direction_rows(make_row, 6, ma8_5d_ago=0.38, ma8_latest=0.35)
        result = calculate_breadth_level_trend(rows)
        assert result["ma8_direction"] == "falling"
        assert result["direction_modifier"] == 5

    def test_rising_low_level_bonus(self, make_row):
        """8MA rising at level < 0.60 -> +5."""
        rows = _make_direction_rows(make_row, 6, ma8_5d_ago=0.40, ma8_latest=0.50)
        result = calculate_breadth_level_trend(rows)
        assert result["ma8_direction"] == "rising"
        assert result["direction_modifier"] == 5

    def test_rising_high_level_no_modifier(self, make_row):
        """8MA rising at level >= 0.60 -> 0 (no modifier)."""
        rows = _make_direction_rows(make_row, 6, ma8_5d_ago=0.62, ma8_latest=0.68)
        result = calculate_breadth_level_trend(rows)
        assert result["ma8_direction"] == "rising"
        assert result["direction_modifier"] == 0

    def test_insufficient_rows_no_modifier(self, make_row):
        """Fewer than 6 rows -> no direction modifier."""
        rows = [make_row(Breadth_Index_8MA=0.55) for _ in range(3)]
        result = calculate_breadth_level_trend(rows)
        assert result.get("direction_modifier", 0) == 0

    def test_flat_no_modifier(self, make_row):
        """8MA unchanged -> no modifier."""
        rows = [make_row(Breadth_Index_8MA=0.55) for _ in range(6)]
        result = calculate_breadth_level_trend(rows)
        assert result.get("direction_modifier", 0) == 0

    def test_score_clamped_0_100(self, make_row):
        """Score should remain in 0-100 after modifier."""
        rows = _make_direction_rows(
            make_row,
            6,
            ma8_5d_ago=0.10,
            ma8_latest=0.15,
            Breadth_200MA_Trend=-1,
        )
        result = calculate_breadth_level_trend(rows)
        assert 0 <= result["score"] <= 100

    def test_modifier_affects_final_score(self, make_row):
        """Direction modifier should change the final score."""
        # Flat -> no modifier
        flat_rows = [make_row(Breadth_Index_8MA=0.65, Breadth_200MA_Trend=1) for _ in range(6)]
        result_flat = calculate_breadth_level_trend(flat_rows)

        # Falling from high -> -10
        falling_rows = _make_direction_rows(
            make_row,
            6,
            ma8_5d_ago=0.70,
            ma8_latest=0.65,
            Breadth_200MA_Trend=1,
        )
        result_falling = calculate_breadth_level_trend(falling_rows)

        assert result_falling["score"] < result_flat["score"]


class TestDirectionModifierBoundary:
    """Boundary tests for 0.40 and 0.60 thresholds (strict inequality)."""

    def test_falling_at_exactly_060_no_modifier(self, make_row):
        """8MA=0.60 falling: > 0.60 is False -> modifier 0."""
        rows = _make_direction_rows(make_row, 6, ma8_5d_ago=0.62, ma8_latest=0.60)
        result = calculate_breadth_level_trend(rows)
        assert result["ma8_direction"] == "falling"
        assert result["direction_modifier"] == 0

    def test_falling_at_exactly_040_no_modifier(self, make_row):
        """8MA=0.40 falling: < 0.40 is False -> modifier 0."""
        rows = _make_direction_rows(make_row, 6, ma8_5d_ago=0.42, ma8_latest=0.40)
        result = calculate_breadth_level_trend(rows)
        assert result["ma8_direction"] == "falling"
        assert result["direction_modifier"] == 0

    def test_rising_at_exactly_060_no_modifier(self, make_row):
        """8MA=0.60 rising: < 0.60 is False -> modifier 0."""
        rows = _make_direction_rows(make_row, 6, ma8_5d_ago=0.58, ma8_latest=0.60)
        result = calculate_breadth_level_trend(rows)
        assert result["ma8_direction"] == "rising"
        assert result["direction_modifier"] == 0
