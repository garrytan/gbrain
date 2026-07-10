"""Tests for macro_regime_detector.py CLI - output directory auto-creation."""

import sys
from unittest.mock import MagicMock, patch

import macro_regime_detector


def test_output_dir_created_when_missing(tmp_path, monkeypatch):
    """--output-dir に存在しないパスを渡しても FileNotFoundError が出ないこと"""
    new_dir = tmp_path / "nonexistent"
    assert not new_dir.exists()

    _fake_comp = {
        "score": 10,
        "signal": "No data",
        "data_available": True,
        "direction": "stable",
        "roc_3m": 0.0,
        "roc_12m": 0.0,
        "crossover": {"type": "none", "bars_ago": None},
        "momentum_qualifier": "",
    }

    monkeypatch.setattr(
        sys,
        "argv",
        ["macro_regime_detector.py", "--api-key", "FAKE_KEY", "--output-dir", str(new_dir)],
    )

    mock_client = MagicMock()
    mock_client.get_historical_prices.return_value = {
        "historical": [{"date": "2026-01-01", "close": 100.0}]
    }
    mock_client.get_treasury_rates.return_value = None
    mock_client.get_api_stats.return_value = {"api_calls_made": 0, "cache_entries": 0}

    with (
        patch("macro_regime_detector.FMPClient", return_value=mock_client),
        patch("macro_regime_detector.calculate_concentration", return_value=_fake_comp),
        patch("macro_regime_detector.calculate_yield_curve", return_value=_fake_comp),
        patch("macro_regime_detector.calculate_credit_conditions", return_value=_fake_comp),
        patch("macro_regime_detector.calculate_size_factor", return_value=_fake_comp),
        patch("macro_regime_detector.calculate_equity_bond", return_value=_fake_comp),
        patch("macro_regime_detector.calculate_sector_rotation", return_value=_fake_comp),
    ):
        macro_regime_detector.main()

    assert new_dir.exists()
