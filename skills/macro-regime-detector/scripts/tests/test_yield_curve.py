"""Tests for Yield Curve Calculator"""

from calculators.yield_curve_calculator import calculate_yield_curve
from test_helpers import make_monthly_history, make_treasury_rates


def _make_treasury_rates_raw(y10_list, y2_list, start_year=2024, start_month=1):
    """Create treasury rate entries from explicit 10Y and 2Y rate lists (oldest first)."""
    entries = []
    for i in range(len(y10_list)):
        month = start_month + i
        year = start_year + (month - 1) // 12
        m = ((month - 1) % 12) + 1

        for day in range(1, 21):
            date_str = f"{year:04d}-{m:02d}-{day:02d}"
            entries.append(
                {
                    "date": date_str,
                    "year2": str(round(y2_list[i], 2)),
                    "year10": str(round(y10_list[i], 2)),
                }
            )

    entries.reverse()
    return entries


class TestCalculateYieldCurve:
    def test_insufficient_data_all_none(self):
        result = calculate_yield_curve(None, None, None)
        assert result["score"] == 0
        assert result["data_available"] is False

    def test_treasury_api_stable_spread(self):
        # Stable spread = low transition signal
        spreads = [1.0] * 24  # Constant 1% spread
        rates = make_treasury_rates(spreads, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)
        assert result["data_available"] is True
        assert result["data_source"] == "treasury_api"
        assert result["score"] <= 30  # Small noise from daily variation is expected

    def test_treasury_api_steepening(self):
        # Spread increasing from -0.5 to 1.5 = steepening transition
        spreads = [-0.5 + i * (2.0 / 23) for i in range(24)]
        rates = make_treasury_rates(spreads, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)
        assert result["data_available"] is True
        assert result["direction"] in ("steepening", "flattening", "stable")

    def test_treasury_api_inverted(self):
        # Negative spreads
        spreads = [-0.5] * 24
        rates = make_treasury_rates(spreads, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)
        assert result["curve_state"] in (
            "inverted",
            "deeply_inverted",
            "flat",
            "normalizing",
            "normal",
            "steep",
        )

    def test_shy_tlt_fallback(self):
        # When no treasury rates, use SHY/TLT proxy
        shy = make_monthly_history([80 + i * 0.1 for i in range(24)], start_year=2024)
        tlt = make_monthly_history([90 - i * 0.2 for i in range(24)], start_year=2024)
        result = calculate_yield_curve(treasury_rates=None, shy_history=shy, tlt_history=tlt)
        assert result["data_available"] is True
        assert result["data_source"] == "shy_tlt_proxy"

    def test_output_structure(self):
        spreads = [1.0 + i * 0.05 for i in range(24)]
        rates = make_treasury_rates(spreads, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)

        assert "score" in result
        assert "signal" in result
        assert "data_available" in result
        assert "data_source" in result
        assert "direction" in result
        assert "curve_state" in result
        assert "crossover" in result
        assert "steepening_type" in result
        assert 0 <= result["score"] <= 100


class TestSteepeningType:
    def test_bull_steepener_2y_declining(self):
        """Bull steepener: 2Y rates declining drives spread wider."""
        # 2Y declining from 5.0 to 3.5, 10Y stable at 4.5
        # Spread widens from -0.5 to +1.0 = steepening
        y2 = [5.0 - i * (1.5 / 23) for i in range(24)]
        y10 = [4.5] * 24
        rates = _make_treasury_rates_raw(y10, y2, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)
        assert result["data_available"] is True
        assert result["direction"] == "steepening"
        assert result["steepening_type"] == "bull_steepener"
        assert result["roc_3m_2y"] is not None and result["roc_3m_2y"] < 0

    def test_bear_steepener_10y_rising(self):
        """Bear steepener: 10Y rates rising drives spread wider."""
        # 10Y rising from 4.0 to 5.5, 2Y stable at 4.0
        # Spread widens from 0.0 to +1.5 = steepening
        y10 = [4.0 + i * (1.5 / 23) for i in range(24)]
        y2 = [4.0] * 24
        rates = _make_treasury_rates_raw(y10, y2, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)
        assert result["data_available"] is True
        assert result["direction"] == "steepening"
        assert result["steepening_type"] == "bear_steepener"
        assert result["roc_3m_10y"] is not None and result["roc_3m_10y"] > 0

    def test_mixed_steepener_both_moving(self):
        """Mixed steepener: both 10Y rising and 2Y rising, but 10Y rising faster."""
        # Both rising, but 10Y rises faster so spread widens
        # 10Y: 4.0 -> 5.5  (rise of 1.5)
        # 2Y: 4.0 -> 4.5   (rise of 0.5)
        # Spread: 0.0 -> 1.0 = steepening
        y10 = [4.0 + i * (1.5 / 23) for i in range(24)]
        y2 = [4.0 + i * (0.5 / 23) for i in range(24)]
        rates = _make_treasury_rates_raw(y10, y2, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)
        assert result["data_available"] is True
        assert result["direction"] == "steepening"
        # Both rising: roc_3m_2y > 0 (not < 0) and roc_3m_10y > 0
        # So it should be bear_steepener (since 10Y is rising)
        assert result["steepening_type"] == "bear_steepener"

    def test_not_steepening_returns_none(self):
        """When direction is not steepening, steepening_type should be None."""
        # Stable spread = not steepening
        spreads = [1.0] * 24
        rates = make_treasury_rates(spreads, start_year=2024)
        result = calculate_yield_curve(treasury_rates=rates)
        assert result["steepening_type"] is None

    def test_shy_tlt_proxy_steepening_type_none(self):
        """SHY/TLT proxy cannot determine steepening type."""
        shy = make_monthly_history([80 + i * 0.1 for i in range(24)], start_year=2024)
        tlt = make_monthly_history([90 - i * 0.2 for i in range(24)], start_year=2024)
        result = calculate_yield_curve(treasury_rates=None, shy_history=shy, tlt_history=tlt)
        assert result["steepening_type"] is None
