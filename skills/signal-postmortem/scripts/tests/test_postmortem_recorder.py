"""
Tests for postmortem_recorder.py
"""

import json

import pytest
from postmortem_recorder import calculate_return, classify_outcome, create_postmortem_record


class TestCalculateReturn:
    """Tests for calculate_return function."""

    def test_positive_return(self):
        """Test positive return calculation."""
        result = calculate_return(100.0, 110.0)
        assert result == pytest.approx(0.10, rel=1e-6)

    def test_negative_return(self):
        """Test negative return calculation."""
        result = calculate_return(100.0, 95.0)
        assert result == pytest.approx(-0.05, rel=1e-6)

    def test_zero_entry_price(self):
        """Test handling of zero entry price."""
        result = calculate_return(0.0, 100.0)
        assert result == 0.0

    def test_no_change(self):
        """Test flat return."""
        result = calculate_return(100.0, 100.0)
        assert result == 0.0


class TestClassifyOutcome:
    """Tests for classify_outcome function."""

    def test_true_positive_long(self):
        """Test TRUE_POSITIVE classification for LONG signal with positive return."""
        result = classify_outcome(
            predicted_direction="LONG",
            return_pct=0.05,
            regime_at_signal="RISK_ON",
            regime_at_exit="RISK_ON",
        )
        assert result == "TRUE_POSITIVE"

    def test_true_positive_short(self):
        """Test TRUE_POSITIVE classification for SHORT signal with negative return."""
        result = classify_outcome(
            predicted_direction="SHORT",
            return_pct=-0.03,
            regime_at_signal="RISK_OFF",
            regime_at_exit="RISK_OFF",
        )
        assert result == "TRUE_POSITIVE"

    def test_false_positive_long(self):
        """Test FALSE_POSITIVE classification for LONG signal with negative return."""
        result = classify_outcome(
            predicted_direction="LONG",
            return_pct=-0.015,
            regime_at_signal="RISK_ON",
            regime_at_exit="RISK_ON",
        )
        assert result == "FALSE_POSITIVE"

    def test_false_positive_severe(self):
        """Test FALSE_POSITIVE_SEVERE classification for large loss."""
        result = classify_outcome(
            predicted_direction="LONG",
            return_pct=-0.05,
            regime_at_signal="RISK_ON",
            regime_at_exit="RISK_ON",
        )
        assert result == "FALSE_POSITIVE_SEVERE"

    def test_neutral_flat_return(self):
        """Test NEUTRAL classification for flat return."""
        result = classify_outcome(
            predicted_direction="LONG",
            return_pct=0.002,
            regime_at_signal="RISK_ON",
            regime_at_exit="RISK_ON",
        )
        assert result == "NEUTRAL"

    def test_regime_mismatch(self):
        """Test REGIME_MISMATCH classification when regime changed."""
        result = classify_outcome(
            predicted_direction="LONG",
            return_pct=-0.03,
            regime_at_signal="RISK_ON",
            regime_at_exit="RISK_OFF",
        )
        assert result == "REGIME_MISMATCH"

    def test_regime_change_but_small_loss(self):
        """Test that small loss with regime change is not REGIME_MISMATCH."""
        result = classify_outcome(
            predicted_direction="LONG",
            return_pct=-0.01,
            regime_at_signal="RISK_ON",
            regime_at_exit="RISK_OFF",
        )
        # Should be FALSE_POSITIVE since loss is < 2%
        assert result == "FALSE_POSITIVE"


class TestCreatePostmortemRecord:
    """Tests for create_postmortem_record function."""

    def test_basic_postmortem_creation(self):
        """Test basic postmortem record creation."""
        signal = {
            "signal_id": "sig_aapl_20260310_abc",
            "ticker": "AAPL",
            "signal_date": "2026-03-10",
            "predicted_direction": "LONG",
            "source_skill": "vcp-screener",
            "entry_price": 170.0,
            "regime": "RISK_ON",
        }

        realized_returns = {"5d": 0.032, "20d": 0.058}

        result = create_postmortem_record(
            signal=signal,
            realized_returns=realized_returns,
            exit_price=175.44,
            exit_date="2026-03-15",
        )

        assert result["schema_version"] == "1.0"
        assert result["postmortem_id"] == "pm_sig_aapl_20260310_abc"
        assert result["signal_id"] == "sig_aapl_20260310_abc"
        assert result["ticker"] == "AAPL"
        assert result["signal_date"] == "2026-03-10"
        assert result["source_skill"] == "vcp-screener"
        assert result["predicted_direction"] == "LONG"
        assert result["entry_price"] == 170.0
        assert result["realized_returns"]["5d"] == 0.032
        assert result["exit_price"] == 175.44
        assert result["exit_date"] == "2026-03-15"
        assert result["holding_days"] == 5
        assert result["outcome_category"] == "TRUE_POSITIVE"
        assert result["regime_at_signal"] == "RISK_ON"
        assert "recorded_at" in result

    def test_postmortem_with_false_positive(self):
        """Test postmortem record with false positive outcome."""
        signal = {
            "signal_id": "sig_nvda_20260305_xyz",
            "ticker": "NVDA",
            "signal_date": "2026-03-05",
            "predicted_direction": "LONG",
            "source_skill": "canslim-screener",
            "entry_price": 900.0,
            "regime": "RISK_ON",
        }

        realized_returns = {"5d": -0.033}

        result = create_postmortem_record(
            signal=signal,
            realized_returns=realized_returns,
            exit_price=870.3,
            exit_date="2026-03-10",
        )

        assert result["outcome_category"] == "FALSE_POSITIVE_SEVERE"
        assert result["holding_days"] == 5

    def test_postmortem_missing_dates(self):
        """Test postmortem with missing dates."""
        signal = {
            "signal_id": "sig_test_abc",
            "ticker": "TEST",
            "signal_date": "",
            "predicted_direction": "LONG",
            "source_skill": "test",
            "entry_price": 100.0,
        }

        result = create_postmortem_record(
            signal=signal, realized_returns={}, exit_price=105.0, exit_date=""
        )

        assert result["holding_days"] == 0
        assert result["outcome_category"] == "NEUTRAL"  # No returns data


class TestIntegration:
    """Integration tests for postmortem recording flow."""

    def test_full_postmortem_flow(self, tmp_path):
        """Test complete postmortem recording to file."""

        signal = {
            "signal_id": "sig_msft_20260301_test",
            "ticker": "MSFT",
            "signal_date": "2026-03-01",
            "predicted_direction": "LONG",
            "source_skill": "earnings-trade-analyzer",
            "entry_price": 420.0,
            "regime": "RISK_ON",
        }

        realized_returns = {"5d": 0.024, "20d": 0.045}

        postmortem = create_postmortem_record(
            signal=signal,
            realized_returns=realized_returns,
            exit_price=430.08,
            exit_date="2026-03-06",
        )

        # Write to file
        output_file = tmp_path / "pm_sig_msft_20260301_test.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(postmortem, f, indent=2)

        # Read back and verify
        with open(output_file) as f:
            loaded = json.load(f)

        assert loaded["ticker"] == "MSFT"
        assert loaded["outcome_category"] == "TRUE_POSITIVE"
        assert loaded["realized_returns"]["5d"] == 0.024
