#!/usr/bin/env python3
"""Tests for market_utils.py"""

import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from market_utils import (
    calculate_trading_days_to_event,
    categorize_volatility,
    format_market_report_header,
    format_percentage_change,
    generate_checklist,
    get_market_session_times,
    get_market_status,
)


class TestGetMarketSessionTimes:
    def test_returns_dict_with_major_markets(self):
        result = get_market_session_times()
        assert isinstance(result, dict)
        expected_markets = ["Tokyo", "Shanghai", "Hong Kong", "Singapore", "London", "New York"]
        for market in expected_markets:
            assert market in result

    def test_each_market_has_open_and_close(self):
        result = get_market_session_times()
        for market, times in result.items():
            assert "open" in times, f"{market} missing 'open'"
            assert "close" in times, f"{market} missing 'close'"

    def test_asian_markets_have_lunch_break(self):
        result = get_market_session_times()
        asian_markets = ["Tokyo", "Shanghai", "Hong Kong", "Singapore"]
        for market in asian_markets:
            assert result[market].get("lunch") is not None, f"{market} should have lunch break"

    def test_western_markets_no_lunch_break(self):
        result = get_market_session_times()
        western_markets = ["London", "New York"]
        for market in western_markets:
            assert result[market].get("lunch") is None, f"{market} should not have lunch break"


class TestFormatMarketReportHeader:
    def test_returns_string(self):
        result = format_market_report_header()
        assert isinstance(result, str)

    def test_contains_title(self):
        result = format_market_report_header()
        assert "Market Environment Report" in result

    @patch("market_utils.datetime")
    def test_contains_formatted_date(self, mock_datetime):
        mock_now = datetime(2025, 3, 15, 14, 30)
        mock_datetime.now.return_value = mock_now
        result = format_market_report_header()
        assert "2025-03-15" in result
        assert "Saturday" in result
        assert "14:30" in result


class TestCalculateTradingDaysToEvent:
    @patch("market_utils.datetime")
    def test_same_day_returns_zero(self, mock_datetime):
        mock_datetime.now.return_value.date.return_value = datetime(2025, 3, 10).date()
        mock_datetime.strptime = datetime.strptime
        result = calculate_trading_days_to_event("2025-03-10")
        assert result == 0

    @patch("market_utils.datetime")
    def test_weekend_excluded(self, mock_datetime):
        # Monday Mar 10 to Monday Mar 17 = 5 trading days
        mock_datetime.now.return_value.date.return_value = datetime(2025, 3, 10).date()
        mock_datetime.strptime = datetime.strptime
        result = calculate_trading_days_to_event("2025-03-17")
        assert result == 5

    @patch("market_utils.datetime")
    def test_within_week(self, mock_datetime):
        # Monday Mar 10 to Friday Mar 14 = 4 trading days
        mock_datetime.now.return_value.date.return_value = datetime(2025, 3, 10).date()
        mock_datetime.strptime = datetime.strptime
        result = calculate_trading_days_to_event("2025-03-14")
        assert result == 4


class TestFormatPercentageChange:
    def test_positive_value(self):
        result = format_percentage_change(1.5)
        assert "+1.50%" in result
        assert "📈" in result

    def test_negative_value(self):
        result = format_percentage_change(-2.3)
        assert "-2.30%" in result
        assert "📉" in result

    def test_zero_value(self):
        result = format_percentage_change(0)
        assert "+0.00%" in result
        assert "📈" in result


class TestCategorizeVolatility:
    def test_low_volatility(self):
        result = categorize_volatility(10)
        assert "Low" in result

    def test_normal_range(self):
        result = categorize_volatility(15)
        assert "Normal" in result

    def test_elevated(self):
        result = categorize_volatility(25)
        assert "Elevated" in result

    def test_high_volatility(self):
        result = categorize_volatility(35)
        assert "High" in result

    def test_extreme_volatility(self):
        result = categorize_volatility(45)
        assert "Extreme" in result

    def test_boundary_values(self):
        assert "Low" in categorize_volatility(11.99)
        assert "Normal" in categorize_volatility(12)
        assert "Normal" in categorize_volatility(19.99)
        assert "Elevated" in categorize_volatility(20)
        assert "Elevated" in categorize_volatility(29.99)
        assert "High" in categorize_volatility(30)
        assert "High" in categorize_volatility(39.99)
        assert "Extreme" in categorize_volatility(40)


class TestGetMarketStatus:
    def test_returns_string(self):
        result = get_market_status()
        assert isinstance(result, str)

    def test_contains_market_names(self):
        result = get_market_status()
        assert "Tokyo" in result
        assert "US" in result


class TestGenerateChecklist:
    def test_returns_string(self):
        result = generate_checklist()
        assert isinstance(result, str)

    def test_contains_checklist_items(self):
        result = generate_checklist()
        assert "US market" in result
        assert "Asian market" in result
        assert "European market" in result
        assert "VIX" in result
        assert "Oil" in result
        assert "Gold" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
