"""Tests for Component 4: Bearish Signal Calculator."""

from calculators.bearish_signal_calculator import calculate_bearish_signal


class TestEmptyData:
    def test_empty_rows_returns_unavailable(self):
        result = calculate_bearish_signal([])
        assert result["score"] == 50
        assert result["data_available"] is False


class TestBaseScore:
    """Base score matrix: signal x trend."""

    def test_signal_off_trend_up(self, make_row):
        rows = [make_row(Bearish_Signal=False, Breadth_200MA_Trend=1)]
        result = calculate_bearish_signal(rows)
        assert result["base_score"] == 85
        assert result["score"] == 85

    def test_signal_off_trend_down(self, make_row):
        rows = [
            make_row(
                Bearish_Signal=False,
                Breadth_200MA_Trend=-1,
                Breadth_Index_8MA=0.55,
                Breadth_Index_200MA=0.50,
            )
        ]
        result = calculate_bearish_signal(rows)
        assert result["base_score"] == 50

    def test_signal_on_trend_up(self, make_row):
        rows = [make_row(Bearish_Signal=True, Breadth_200MA_Trend=1, Breadth_Index_8MA=0.40)]
        result = calculate_bearish_signal(rows)
        assert result["base_score"] == 30

    def test_signal_on_trend_down(self, make_row):
        rows = [make_row(Bearish_Signal=True, Breadth_200MA_Trend=-1, Breadth_Index_8MA=0.40)]
        result = calculate_bearish_signal(rows)
        assert result["base_score"] == 10


class TestContextAdjustment:
    """Context adjustment when signal is active."""

    def test_signal_on_high_8ma_gets_plus15(self, make_row):
        rows = [make_row(Bearish_Signal=True, Breadth_200MA_Trend=1, Breadth_Index_8MA=0.55)]
        result = calculate_bearish_signal(rows)
        assert result["context_adjustment"] == 15
        assert result["score"] == 30 + 15  # base + adj

    def test_signal_on_low_8ma_gets_minus5(self, make_row):
        rows = [make_row(Bearish_Signal=True, Breadth_200MA_Trend=-1, Breadth_Index_8MA=0.20)]
        result = calculate_bearish_signal(rows)
        assert result["context_adjustment"] == -5
        assert result["score"] == 10 - 5  # base + adj

    def test_no_adjustment_when_signal_off(self, make_row):
        rows = [make_row(Bearish_Signal=False, Breadth_200MA_Trend=1, Breadth_Index_8MA=0.55)]
        result = calculate_bearish_signal(rows)
        assert result["context_adjustment"] == 0


class TestPinkZone:
    """Pink Zone = trend=-1 AND 8MA < 200MA."""

    def test_pink_zone_detected(self, make_row):
        rows = [
            make_row(
                Breadth_200MA_Trend=-1,
                Breadth_Index_8MA=0.45,
                Breadth_Index_200MA=0.50,
                Bearish_Signal=False,
            )
        ]
        result = calculate_bearish_signal(rows)
        assert result["in_pink_zone"] is True

    def test_pink_zone_penalty_without_signal(self, make_row):
        rows = [
            make_row(
                Breadth_200MA_Trend=-1,
                Breadth_Index_8MA=0.45,
                Breadth_Index_200MA=0.50,
                Bearish_Signal=False,
            )
        ]
        result = calculate_bearish_signal(rows)
        assert result["pink_zone_adjustment"] == -10
        assert result["score"] == 50 - 10  # base=50 (off+down) - 10

    def test_no_pink_zone_when_8ma_above_200ma(self, make_row):
        rows = [
            make_row(
                Breadth_200MA_Trend=-1,
                Breadth_Index_8MA=0.55,
                Breadth_Index_200MA=0.50,
                Bearish_Signal=False,
            )
        ]
        result = calculate_bearish_signal(rows)
        assert result["in_pink_zone"] is False
        assert result["pink_zone_adjustment"] == 0

    def test_no_pink_zone_penalty_when_signal_active(self, make_row):
        rows = [
            make_row(
                Breadth_200MA_Trend=-1,
                Breadth_Index_8MA=0.45,
                Breadth_Index_200MA=0.50,
                Bearish_Signal=True,
            )
        ]
        result = calculate_bearish_signal(rows)
        # Pink zone detected but no extra penalty when signal already active
        assert result["pink_zone_adjustment"] == 0

    def test_pink_zone_days_counted(self, make_row):
        rows = [
            make_row(
                Date="2025-01-01",
                Breadth_200MA_Trend=1,
                Breadth_Index_8MA=0.55,
                Breadth_Index_200MA=0.50,
            ),
            make_row(
                Date="2025-01-02",
                Breadth_200MA_Trend=-1,
                Breadth_Index_8MA=0.48,
                Breadth_Index_200MA=0.50,
                Bearish_Signal=False,
            ),
            make_row(
                Date="2025-01-03",
                Breadth_200MA_Trend=-1,
                Breadth_Index_8MA=0.46,
                Breadth_Index_200MA=0.50,
                Bearish_Signal=False,
            ),
        ]
        result = calculate_bearish_signal(rows)
        assert result["pink_zone_days"] == 2


class TestScoreClamping:
    """Score should be clamped to 0-100."""

    def test_score_does_not_exceed_100(self, make_row):
        rows = [make_row(Bearish_Signal=False, Breadth_200MA_Trend=1)]
        result = calculate_bearish_signal(rows)
        assert 0 <= result["score"] <= 100

    def test_score_does_not_go_below_0(self, make_row):
        rows = [make_row(Bearish_Signal=True, Breadth_200MA_Trend=-1, Breadth_Index_8MA=0.20)]
        result = calculate_bearish_signal(rows)
        assert result["score"] >= 0
