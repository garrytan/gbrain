"""Tests for Component 3: Peak/Trough Cycle Calculator."""

from calculators.cycle_calculator import calculate_cycle_position


class TestDataAvailability:
    """Marker-not-found should yield data_available=False."""

    def test_no_marker_returns_data_available_false(self, make_rows):
        """120 rows with no peak/trough -> data_available False."""
        rows = make_rows(120)
        result = calculate_cycle_position(rows)
        assert result["data_available"] is False
        assert result["score"] == 50

    def test_marker_present_returns_data_available_true(self, make_rows):
        """A trough marker within lookback -> data_available True."""
        rows = make_rows(120)
        rows[-10]["Is_Trough"] = True
        # Make 8MA rising so we get a proper score
        rows[-1]["Breadth_Index_8MA"] = 0.55
        rows[-6]["Breadth_Index_8MA"] = 0.45
        result = calculate_cycle_position(rows)
        assert result["data_available"] is True
        assert result["score"] != 50  # Should be a real score

    def test_insufficient_data_returns_data_available_false(self, make_rows):
        """Fewer than 10 rows -> data_available False."""
        rows = make_rows(5)
        result = calculate_cycle_position(rows)
        assert result["data_available"] is False

    def test_peak_marker_returns_data_available_true(self, make_rows):
        """A peak marker within lookback -> data_available True."""
        rows = make_rows(30)
        rows[-5]["Is_Peak"] = True
        rows[-1]["Breadth_Index_8MA"] = 0.40
        rows[-6]["Breadth_Index_8MA"] = 0.50
        result = calculate_cycle_position(rows)
        assert result["data_available"] is True
