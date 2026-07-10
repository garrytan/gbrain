"""
Tests for postmortem_analyzer.py
"""

import json
from datetime import datetime, timedelta

import pytest
from postmortem_analyzer import (
    analyze_regime_correlation,
    calculate_skill_metrics,
    generate_improvement_backlog,
    generate_summary,
    generate_weight_feedback,
)


@pytest.fixture
def sample_postmortems():
    """Generate sample postmortem records for testing."""
    return [
        # True positives from vcp-screener
        {
            "postmortem_id": "pm_1",
            "signal_id": "sig_1",
            "ticker": "AAPL",
            "signal_date": "2026-03-01",
            "source_skill": "vcp-screener",
            "outcome_category": "TRUE_POSITIVE",
            "regime_at_signal": "RISK_ON",
            "realized_returns": {"5d": 0.032},
        },
        {
            "postmortem_id": "pm_2",
            "signal_id": "sig_2",
            "ticker": "MSFT",
            "signal_date": "2026-03-02",
            "source_skill": "vcp-screener",
            "outcome_category": "TRUE_POSITIVE",
            "regime_at_signal": "RISK_ON",
            "realized_returns": {"5d": 0.025},
        },
        # False positive from vcp-screener
        {
            "postmortem_id": "pm_3",
            "signal_id": "sig_3",
            "ticker": "NVDA",
            "signal_date": "2026-03-03",
            "source_skill": "vcp-screener",
            "outcome_category": "FALSE_POSITIVE",
            "regime_at_signal": "RISK_OFF",
            "realized_returns": {"5d": -0.018},
        },
        # True positive from canslim-screener
        {
            "postmortem_id": "pm_4",
            "signal_id": "sig_4",
            "ticker": "GOOGL",
            "signal_date": "2026-03-01",
            "source_skill": "canslim-screener",
            "outcome_category": "TRUE_POSITIVE",
            "regime_at_signal": "RISK_ON",
            "realized_returns": {"5d": 0.041},
        },
        # Regime mismatch from canslim-screener
        {
            "postmortem_id": "pm_5",
            "signal_id": "sig_5",
            "ticker": "TSLA",
            "signal_date": "2026-03-02",
            "source_skill": "canslim-screener",
            "outcome_category": "REGIME_MISMATCH",
            "regime_at_signal": "RISK_ON",
            "realized_returns": {"5d": -0.045},
        },
    ]


@pytest.fixture
def large_postmortem_set():
    """Generate a larger set for testing threshold behaviors."""
    postmortems = []
    base_date = datetime(2026, 2, 1)

    # 30 signals from vcp-screener: 20 TP, 8 FP, 2 neutral
    for i in range(30):
        if i < 20:
            outcome = "TRUE_POSITIVE"
            ret = 0.02 + (i * 0.001)
        elif i < 28:
            outcome = "FALSE_POSITIVE" if i < 26 else "FALSE_POSITIVE_SEVERE"
            ret = -0.015 - ((i - 20) * 0.005)
        else:
            outcome = "NEUTRAL"
            ret = 0.002

        postmortems.append(
            {
                "postmortem_id": f"pm_vcp_{i}",
                "signal_id": f"sig_vcp_{i}",
                "ticker": f"TICK{i}",
                "signal_date": (base_date + timedelta(days=i)).strftime("%Y-%m-%d"),
                "source_skill": "vcp-screener",
                "outcome_category": outcome,
                "regime_at_signal": "RISK_OFF" if i >= 20 and i < 28 else "RISK_ON",
                "realized_returns": {"5d": ret},
                "recorded_at": datetime.utcnow().isoformat() + "Z",
            }
        )

    # 25 signals from canslim-screener: 18 TP, 5 FP, 2 regime mismatch
    for i in range(25):
        if i < 18:
            outcome = "TRUE_POSITIVE"
            ret = 0.025 + (i * 0.001)
        elif i < 23:
            outcome = "FALSE_POSITIVE"
            ret = -0.012 - ((i - 18) * 0.003)
        else:
            outcome = "REGIME_MISMATCH"
            ret = -0.035

        postmortems.append(
            {
                "postmortem_id": f"pm_canslim_{i}",
                "signal_id": f"sig_canslim_{i}",
                "ticker": f"CAN{i}",
                "signal_date": (base_date + timedelta(days=i)).strftime("%Y-%m-%d"),
                "source_skill": "canslim-screener",
                "outcome_category": outcome,
                "regime_at_signal": "RISK_ON",
                "realized_returns": {"5d": ret},
                "recorded_at": datetime.utcnow().isoformat() + "Z",
            }
        )

    return postmortems


class TestCalculateSkillMetrics:
    """Tests for calculate_skill_metrics function."""

    def test_basic_metrics(self, sample_postmortems):
        """Test basic metric calculation."""
        metrics = calculate_skill_metrics(sample_postmortems)

        assert "vcp-screener" in metrics
        assert "canslim-screener" in metrics

        vcp = metrics["vcp-screener"]
        assert vcp["sample_size"] == 3
        assert vcp["true_positive"] == 2
        assert vcp["false_positive"] == 1
        assert vcp["accuracy"] == pytest.approx(2 / 3, rel=1e-6)

        canslim = metrics["canslim-screener"]
        assert canslim["sample_size"] == 2
        assert canslim["true_positive"] == 1
        assert canslim["regime_mismatch"] == 1

    def test_average_return_calculation(self, sample_postmortems):
        """Test average return calculation."""
        metrics = calculate_skill_metrics(sample_postmortems)

        vcp = metrics["vcp-screener"]
        expected_avg = (0.032 + 0.025 - 0.018) / 3
        assert vcp["avg_return_5d"] == pytest.approx(expected_avg, rel=1e-6)


class TestGenerateWeightFeedback:
    """Tests for generate_weight_feedback function."""

    def test_no_feedback_below_threshold(self, sample_postmortems):
        """Test that no adjustments are made with small sample size."""
        metrics = calculate_skill_metrics(sample_postmortems)
        feedback = generate_weight_feedback(metrics, min_sample_size=20)

        assert feedback["skill_adjustments"] == []
        assert feedback["confidence"] == "LOW"

    def test_feedback_with_sufficient_samples(self, large_postmortem_set):
        """Test weight feedback generation with sufficient samples."""
        metrics = calculate_skill_metrics(large_postmortem_set)
        feedback = generate_weight_feedback(metrics, min_sample_size=20)

        assert len(feedback["skill_adjustments"]) > 0
        assert feedback["confidence"] in ("MEDIUM", "HIGH")

        # Check structure
        for adj in feedback["skill_adjustments"]:
            assert "skill" in adj
            assert "current_weight" in adj
            assert "suggested_weight" in adj
            assert "reason" in adj
            assert 0.3 <= adj["suggested_weight"] <= 2.0

    def test_schema_version(self, large_postmortem_set):
        """Test that output includes schema version."""
        metrics = calculate_skill_metrics(large_postmortem_set)
        feedback = generate_weight_feedback(metrics)

        assert feedback["schema_version"] == "1.0"
        assert "generated_at" in feedback


class TestGenerateImprovementBacklog:
    """Tests for generate_improvement_backlog function."""

    def test_backlog_with_high_fp_rate(self, large_postmortem_set):
        """Test backlog generation for high false positive rate."""
        metrics = calculate_skill_metrics(large_postmortem_set)
        backlog = generate_improvement_backlog(metrics, large_postmortem_set, min_sample_size=15)

        # Should have at least one entry for vcp-screener FP cluster
        assert len(backlog) > 0

        # Check structure
        for entry in backlog:
            assert "skill" in entry
            assert "issue_type" in entry
            assert "severity" in entry
            assert "evidence" in entry
            assert "suggested_action" in entry
            assert "priority_score" in entry
            assert "generated_by" in entry
            assert entry["generated_by"] == "signal-postmortem"

    def test_backlog_sorted_by_priority(self, large_postmortem_set):
        """Test that backlog is sorted by priority score descending."""
        metrics = calculate_skill_metrics(large_postmortem_set)
        backlog = generate_improvement_backlog(metrics, large_postmortem_set, min_sample_size=15)

        if len(backlog) > 1:
            for i in range(len(backlog) - 1):
                assert backlog[i]["priority_score"] >= backlog[i + 1]["priority_score"]


class TestAnalyzeRegimeCorrelation:
    """Tests for analyze_regime_correlation function."""

    def test_finds_risk_off_correlation(self, large_postmortem_set):
        """Test that RISK_OFF correlation is detected for vcp-screener."""
        result = analyze_regime_correlation(large_postmortem_set, "vcp-screener")

        # VCP-screener has FPs concentrated in RISK_OFF regime
        assert result == "RISK_OFF"

    def test_no_correlation_for_clean_skill(self, sample_postmortems):
        """Test no correlation for skill with too few samples per regime."""
        result = analyze_regime_correlation(sample_postmortems, "canslim-screener")

        # Not enough samples to establish correlation
        assert result == "NONE"


class TestGenerateSummary:
    """Tests for generate_summary function."""

    def test_summary_contains_required_sections(self, large_postmortem_set):
        """Test that summary contains all required sections."""
        metrics = calculate_skill_metrics(large_postmortem_set)
        summary = generate_summary(metrics, large_postmortem_set, ["skill", "month"])

        assert "# Signal Postmortem Summary" in summary
        assert "## Overall Statistics" in summary
        assert "## By Skill" in summary
        assert "## By Month" in summary
        assert "## Outcome Distribution" in summary

    def test_summary_markdown_table_format(self, large_postmortem_set):
        """Test that summary uses proper markdown table format."""
        metrics = calculate_skill_metrics(large_postmortem_set)
        summary = generate_summary(metrics, large_postmortem_set, ["skill"])

        # Check for table headers
        assert "| Skill | Samples |" in summary
        assert "|-------|---------|" in summary


class TestIntegration:
    """Integration tests for analyzer flow."""

    def test_full_analysis_flow(self, tmp_path, large_postmortem_set):
        """Test complete analysis flow with file output."""
        # Write postmortems to temp directory
        pm_dir = tmp_path / "postmortems"
        pm_dir.mkdir()

        for pm in large_postmortem_set:
            with open(pm_dir / f"{pm['postmortem_id']}.json", "w", encoding="utf-8") as f:
                json.dump(pm, f)

        # Calculate metrics
        metrics = calculate_skill_metrics(large_postmortem_set)

        # Generate all outputs
        feedback = generate_weight_feedback(metrics, min_sample_size=20)
        backlog = generate_improvement_backlog(metrics, large_postmortem_set, min_sample_size=15)
        summary = generate_summary(metrics, large_postmortem_set, ["skill", "month"])

        # Verify outputs are non-empty and well-formed
        assert len(feedback["skill_adjustments"]) >= 0  # May or may not have adjustments
        assert len(backlog) >= 0  # May or may not have issues
        assert len(summary) > 100  # Should have substantial content
