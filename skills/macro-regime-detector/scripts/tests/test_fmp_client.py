"""Issue #64: stable/historical-price-eod/full normalization for macro-regime-detector."""

import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fmp_client import FMPClient


def _make_client():
    client = FMPClient(api_key="test_key")
    client.max_retries = 0
    return client


def _mock_response(status_code, json_payload):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_payload
    resp.text = ""
    return resp


class TestEODFlatListSuccess:
    @patch("fmp_client.requests.Session")
    def test_get_historical_prices_normalizes_flat_list(self, mock_session_class):
        """Flat list response -> dict contract preserved."""
        mock_session = MagicMock()
        mock_session.get.return_value = _mock_response(
            200,
            [
                {
                    "symbol": "SPY",
                    "date": "2026-04-29",
                    "open": 500.0,
                    "high": 502.0,
                    "low": 499.0,
                    "close": 501.0,
                    "volume": 1_000_000,
                },
                {
                    "symbol": "SPY",
                    "date": "2026-04-28",
                    "open": 498.0,
                    "high": 501.0,
                    "low": 497.0,
                    "close": 500.0,
                    "volume": 1_100_000,
                },
            ],
        )
        mock_session_class.return_value = mock_session

        client = _make_client()
        client.session = mock_session

        result = client.get_historical_prices("SPY", days=2)
        assert isinstance(result, dict), f"expected dict, got {type(result).__name__}"
        assert result["symbol"] == "SPY"
        assert len(result["historical"]) == 2
        assert result["historical"][0]["close"] == 501.0

        first_call = mock_session.get.call_args_list[0]
        url = first_call[0][0]
        params = first_call[1]["params"]
        assert "historical-price-eod/full" in url
        assert "from" in params and "to" in params
        assert "timeseries" not in params


class _FakeDF:
    """Minimal stand-in for a yfinance DataFrame (ascending by date)."""

    def __init__(self, rows):
        self._rows = rows  # list of (Timestamp-like, dict)
        self.empty = len(rows) == 0
        self.columns = _FakeColumns()

    def iterrows(self):
        return iter(self._rows)


class _FakeColumns:
    """Plain columns object WITHOUT a `levels` attr (no MultiIndex)."""


class _FakeTS:
    def __init__(self, iso):
        self._iso = iso

    def strftime(self, fmt):
        # tests only use %Y-%m-%d
        return self._iso


def _row(iso, o, h, lo, c, v):
    return (
        _FakeTS(iso),
        {"Open": o, "High": h, "Low": lo, "Close": c, "Volume": v},
    )


class TestYFinanceFallback:
    """get_historical_prices falls back to yfinance when FMP returns nothing."""

    @patch.object(FMPClient, "_request_with_fallback", return_value=None)
    def test_fallback_invoked_and_shape(self, _mock_fmp):
        client = _make_client()
        fake_df = _FakeDF(
            [
                _row("2026-04-27", 1.0, 2.0, 0.5, 1.5, 100),
                _row("2026-04-28", 1.5, 2.5, 1.0, 2.0, 200),
                _row("2026-04-29", 2.0, 3.0, 1.5, 2.5, 300),
            ]
        )
        fake_yf = MagicMock()
        fake_yf.download.return_value = fake_df

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("XLK", days=10)

        assert isinstance(result, dict)
        assert result["symbol"] == "XLK"
        hist = result["historical"]
        assert len(hist) == 3
        # Most-recent-first (descending) per FMP contract
        assert hist[0]["date"] == "2026-04-29"
        assert hist[-1]["date"] == "2026-04-27"
        bar = hist[0]
        for key in ("date", "open", "high", "low", "close", "adjClose", "volume"):
            assert key in bar
        assert bar["close"] == bar["adjClose"] == 2.5
        assert bar["volume"] == 300

    @patch.object(FMPClient, "_request_with_fallback", return_value=None)
    def test_days_limit_applied(self, _mock_fmp):
        client = _make_client()
        rows = [_row(f"2026-04-{d:02d}", 1, 2, 0, 1.0 + d, 10 * d) for d in range(1, 11)]
        fake_df = _FakeDF(rows)
        fake_yf = MagicMock()
        fake_yf.download.return_value = fake_df

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("XLF", days=3)

        assert len(result["historical"]) == 3
        # Newest 3 dates kept (descending)
        assert result["historical"][0]["date"] == "2026-04-10"

    @patch.object(FMPClient, "_request_with_fallback", return_value=None)
    def test_empty_df_returns_none_and_not_cached(self, _mock_fmp):
        client = _make_client()
        fake_yf = MagicMock()
        fake_yf.download.return_value = _FakeDF([])

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("XLV", days=5)

        assert result is None
        assert "prices_XLV_5" not in client.cache

    @patch.object(FMPClient, "_request_with_fallback", return_value=None)
    def test_exception_returns_none_and_not_cached(self, _mock_fmp):
        client = _make_client()
        fake_yf = MagicMock()
        fake_yf.download.side_effect = RuntimeError("network down")

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("XLE", days=5)

        assert result is None
        assert "prices_XLE_5" not in client.cache

    @patch.object(FMPClient, "_request_with_fallback")
    def test_fmp_success_does_not_call_yfinance(self, mock_fmp):
        mock_fmp.return_value = {
            "symbol": "SPY",
            "historical": [{"date": "2026-04-29", "close": 1.0}],
        }
        client = _make_client()
        fake_yf = MagicMock()

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("SPY", days=5)

        assert result["symbol"] == "SPY"
        fake_yf.download.assert_not_called()

    @patch.object(FMPClient, "_request_with_fallback")
    def test_empty_historical_dict_triggers_yfinance(self, mock_fmp):
        # v3 can return a truthy dict with an EMPTY historical list for an
        # ETF unavailable on the caller's plan. Must still fall back.
        mock_fmp.return_value = {"symbol": "XLK", "historical": []}
        client = _make_client()
        fake_df = _FakeDF([_row("2026-04-29", 2.0, 3.0, 1.5, 2.5, 300)])
        fake_yf = MagicMock()
        fake_yf.download.return_value = fake_df

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("XLK", days=5)

        fake_yf.download.assert_called_once()
        assert result["symbol"] == "XLK"
        assert len(result["historical"]) == 1
        assert client.cache["prices_XLK_5"] is result

    @patch.object(FMPClient, "_request_with_fallback")
    def test_empty_historical_then_yfinance_empty_returns_none_not_cached(self, mock_fmp):
        mock_fmp.return_value = {"symbol": "XLK", "historical": []}
        client = _make_client()
        fake_yf = MagicMock()
        fake_yf.download.return_value = _FakeDF([])

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("XLK", days=5)

        assert result is None
        assert "prices_XLK_5" not in client.cache

    @patch.object(FMPClient, "_request_with_fallback")
    def test_empty_historicalstocklist_entry_triggers_yfinance(self, mock_fmp):
        # historicalStockList path can yield {"symbol":..., "historical": []}
        mock_fmp.return_value = {"symbol": "XLF", "historical": []}
        client = _make_client()
        fake_df = _FakeDF([_row("2026-04-29", 1.0, 2.0, 0.5, 1.5, 100)])
        fake_yf = MagicMock()
        fake_yf.download.return_value = fake_df

        with patch.dict("sys.modules", {"yfinance": fake_yf}):
            result = client.get_historical_prices("XLF", days=5)

        fake_yf.download.assert_called_once()
        assert result["symbol"] == "XLF"
        assert len(result["historical"]) == 1


class TestHasUsableHistory:
    """Unit tests for the _has_usable_history helper."""

    def test_none(self):
        from fmp_client import _has_usable_history

        assert _has_usable_history(None) is False

    def test_empty_historical_list(self):
        from fmp_client import _has_usable_history

        assert _has_usable_history({"symbol": "X", "historical": []}) is False

    def test_missing_historical_key(self):
        from fmp_client import _has_usable_history

        assert _has_usable_history({"symbol": "X"}) is False

    def test_non_dict(self):
        from fmp_client import _has_usable_history

        assert _has_usable_history([{"date": "2026-04-29"}]) is False

    def test_non_empty_historical(self):
        from fmp_client import _has_usable_history

        assert _has_usable_history({"historical": [{"date": "2026-04-29"}]}) is True
