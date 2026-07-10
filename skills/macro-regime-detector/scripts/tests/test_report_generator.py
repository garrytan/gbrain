"""Tests for Macro Regime Detector Report Generator"""

import os
import tempfile

from report_generator import generate_markdown_report


def _make_analysis(
    regime="contraction",
    confidence="high",
    ambiguous=False,
    tied_regimes=None,
    yield_curve_source="treasury_api",
):
    """Build a minimal analysis dict for report generation."""
    return {
        "metadata": {
            "generated_at": "2026-02-21 17:00:00",
            "api_calls": {"api_calls_made": 10},
        },
        "composite": {
            "composite_score": 51.0,
            "zone": "Transition Zone (Preparing)",
            "zone_color": "orange",
            "guidance": "Multiple indicators in transition.",
            "actions": ["Develop response plan", "Weekly monitoring"],
            "signaling_components": 5,
            "strongest_signal": {"label": "Size Factor (IWM/SPY)", "score": 80},
            "weakest_signal": {"label": "Equity-Bond (SPY/TLT)", "score": 10},
            "data_quality": {"label": "Complete (6/6 components)"},
            "component_scores": {
                "concentration": {
                    "score": 40,
                    "weight": 0.25,
                    "label": "Market Concentration (RSP/SPY)",
                },
                "yield_curve": {"score": 60, "weight": 0.20, "label": "Yield Curve (10Y-2Y)"},
                "credit_conditions": {
                    "score": 50,
                    "weight": 0.15,
                    "label": "Credit Conditions (HYG/LQD)",
                },
                "size_factor": {"score": 80, "weight": 0.15, "label": "Size Factor (IWM/SPY)"},
                "equity_bond": {"score": 10, "weight": 0.15, "label": "Equity-Bond (SPY/TLT)"},
                "sector_rotation": {
                    "score": 80,
                    "weight": 0.10,
                    "label": "Sector Rotation (XLY/XLP)",
                },
            },
        },
        "regime": {
            "current_regime": regime,
            "regime_label": regime.capitalize(),
            "regime_description": "Test regime description.",
            "confidence": confidence,
            "regime_scores": {
                "concentration": 2,
                "broadening": 2,
                "contraction": 4,
                "inflationary": 3,
                "transitional": 0,
            },
            "portfolio_posture": "Raise cash. Increase Treasury allocation.",
            "transition_probability": {
                "level": "high",
                "probability_range": "70-90%",
                "signaling_count": 5,
                "ambiguous": ambiguous,
                "from_regime": None,
                "to_regime": None,
            },
            "evidence": [
                {
                    "component": "Size Factor",
                    "score": 80,
                    "direction": "small_cap_leading",
                    "signal": "test",
                },
            ],
            "tied_regimes": tied_regimes,
            "consistency": {
                "concentration": "neutral",
                "yield_curve": "neutral",
                "credit_conditions": "consistent",
                "size_factor": "contradicting",
                "equity_bond": "contradicting",
                "sector_rotation": "consistent",
            },
        },
        "components": {
            "concentration": {
                "data_available": True,
                "direction": "concentrating",
                "current_ratio": 0.296,
                "current_date": "2026-02-20",
                "sma_6m": 0.284,
                "sma_12m": 0.291,
                "roc_3m": 5.73,
                "roc_12m": -1.84,
                "percentile": 26.7,
                "signal": "test",
                "crossover": {"type": "none", "bars_ago": None},
            },
            "yield_curve": {
                "data_available": True,
                "direction": "flattening",
                "data_source": yield_curve_source,
                "sma_6m": 0.935,
                "sma_12m": 0.940,
                "roc_3m": 0.56,
                "roc_12m": 3.25,
                "percentile": 60.0,
                "signal": "test",
                "crossover": {"type": "death_cross", "bars_ago": 0},
                "current_date": "2026-02-20",
            },
            "credit_conditions": {
                "data_available": True,
                "direction": "tightening",
                "current_ratio": 0.726,
                "current_date": "2026-02-20",
                "sma_6m": 0.727,
                "sma_12m": 0.727,
                "roc_3m": 0.54,
                "roc_12m": 0.58,
                "percentile": 70.0,
                "signal": "test",
                "crossover": {"type": "death_cross", "bars_ago": 0},
            },
            "size_factor": {
                "data_available": True,
                "direction": "small_cap_leading",
                "momentum_qualifier": "confirmed",
                "current_ratio": 0.384,
                "current_date": "2026-02-20",
                "sma_6m": 0.368,
                "sma_12m": 0.360,
                "roc_3m": 5.49,
                "roc_12m": 6.19,
                "percentile": 53.3,
                "signal": "test",
                "crossover": {"type": "golden_cross", "bars_ago": 2},
            },
            "equity_bond": {
                "data_available": True,
                "direction": "risk_on",
                "current_ratio": 7.711,
                "current_date": "2026-02-20",
                "sma_6m": 7.732,
                "sma_12m": 7.356,
                "roc_3m": 0.94,
                "roc_12m": 16.18,
                "percentile": 90.0,
                "signal": "test",
                "crossover": {"type": "none", "bars_ago": None},
                "correlation_6m": 0.457,
                "correlation_12m": 0.158,
                "correlation_regime": "positive",
            },
            "sector_rotation": {
                "data_available": True,
                "direction": "risk_off",
                "momentum_qualifier": "reversing",
                "current_ratio": 1.336,
                "current_date": "2026-02-20",
                "sma_6m": 1.491,
                "sma_12m": 1.410,
                "roc_3m": -10.83,
                "roc_12m": 0.95,
                "percentile": 60.0,
                "signal": "test",
                "crossover": {"type": "golden_cross", "bars_ago": 5},
            },
        },
    }


class TestCompetingRegimeRecommendations:
    def test_tied_regimes_shows_competing_posture(self):
        """When tied_regimes exists, report should show competing regime's posture."""
        analysis = _make_analysis(
            regime="contraction",
            ambiguous=True,
            tied_regimes=["contraction", "inflationary"],
        )
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            path = f.name

        try:
            generate_markdown_report(analysis, path)
            with open(path) as f:
                content = f.read()
            # Should mention competing regime posture
            assert "Competing" in content or "Inflationary" in content
            # Should warn about contradictions when applicable
            assert "Inflationary" in content
        finally:
            os.unlink(path)

    def test_no_tied_regimes_no_competing_posture(self):
        """When no tied_regimes, report should not show competing posture section."""
        analysis = _make_analysis(regime="contraction", tied_regimes=None)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            path = f.name

        try:
            generate_markdown_report(analysis, path)
            with open(path) as f:
                content = f.read()
            assert "Competing Regime" not in content
        finally:
            os.unlink(path)


class TestClassificationConfidenceLabel:
    def test_report_shows_classification_confidence_label(self):
        """レポートに 'Classification Confidence' が含まれ 'Transition Confidence' が含まれないこと"""
        analysis = _make_analysis()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            path = f.name
        try:
            generate_markdown_report(analysis, path)
            with open(path) as f:
                content = f.read()
            assert "Classification Confidence" in content
            assert "Transition Confidence" not in content
        finally:
            os.unlink(path)

    def test_report_footnote_contains_destination_clarity(self):
        """footnote に Destination Clarity の説明が残っていること"""
        analysis = _make_analysis()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            path = f.name
        try:
            generate_markdown_report(analysis, path)
            with open(path) as f:
                content = f.read()
            assert "Destination Clarity" in content
        finally:
            os.unlink(path)

    def test_report_footnote_separates_classification_from_transition_probability(self):
        """footnote が Classification Confidence と Transition Probability を別指標として明記すること"""
        analysis = _make_analysis()
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            path = f.name
        try:
            generate_markdown_report(analysis, path)
            with open(path) as f:
                content = f.read()
            assert "Transition Probability" in content
            assert "Classification Confidence" in content
        finally:
            os.unlink(path)


class TestYieldCurveProxyWarning:
    def test_proxy_source_shows_warning(self):
        """When yield curve uses SHY/TLT proxy, report should warn about reduced resolution."""
        analysis = _make_analysis(yield_curve_source="shy_tlt_proxy")
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            path = f.name

        try:
            generate_markdown_report(analysis, path)
            with open(path) as f:
                content = f.read()
            # Should contain a proxy warning
            assert "proxy" in content.lower() or "SHY/TLT" in content
        finally:
            os.unlink(path)

    def test_treasury_api_source_no_warning(self):
        """When yield curve uses treasury API, no proxy warning should appear in component section."""
        analysis = _make_analysis(yield_curve_source="treasury_api")
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            path = f.name

        try:
            generate_markdown_report(analysis, path)
            with open(path) as f:
                content = f.read()
            assert "reduced resolution" not in content.lower()
        finally:
            os.unlink(path)
