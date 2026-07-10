"""Tests for report_generator.py — incremental across Steps 1-4."""

import os
import tempfile

from report_generator import generate_markdown_report


def _base_analysis(**overrides):
    """Return a minimal analysis dict for report generation."""
    analysis = {
        "metadata": {
            "generated_at": "2025-01-15 10:00:00",
            "data_source": "Test",
            "detail_url": "http://test",
            "summary_url": "http://test",
            "total_rows": 100,
            "data_freshness": {
                "latest_date": "2025-01-14",
                "days_old": 1,
                "warning": None,
                "last_modified": None,
            },
        },
        "composite": {
            "composite_score": 60.0,
            "zone": "Healthy",
            "zone_color": "blue",
            "exposure_guidance": "75-90%",
            "guidance": "Normal ops",
            "actions": ["Action 1"],
            "strongest_health": {
                "component": "breadth_level_trend",
                "label": "Current Breadth Level & Trend",
                "score": 80,
            },
            "weakest_health": {
                "component": "divergence",
                "label": "S&P 500 vs Breadth Divergence",
                "score": 40,
            },
            "excluded_components": [],
            "data_quality": {
                "available_count": 6,
                "total_components": 6,
                "label": "Complete (6/6 components)",
                "missing_components": [],
            },
            "component_scores": {
                "breadth_level_trend": {
                    "score": 80,
                    "weight": 0.25,
                    "effective_weight": 0.25,
                    "weighted_contribution": 20.0,
                    "data_available": True,
                    "label": "Current Breadth Level & Trend",
                },
                "ma_crossover": {
                    "score": 60,
                    "weight": 0.20,
                    "effective_weight": 0.20,
                    "weighted_contribution": 12.0,
                    "data_available": True,
                    "label": "8MA vs 200MA Crossover",
                },
                "cycle_position": {
                    "score": 50,
                    "weight": 0.20,
                    "effective_weight": 0.20,
                    "weighted_contribution": 10.0,
                    "data_available": True,
                    "label": "Peak/Trough Cycle Position",
                },
                "bearish_signal": {
                    "score": 70,
                    "weight": 0.15,
                    "effective_weight": 0.15,
                    "weighted_contribution": 10.5,
                    "data_available": True,
                    "label": "Bearish Signal Status",
                },
                "historical_percentile": {
                    "score": 55,
                    "weight": 0.10,
                    "effective_weight": 0.10,
                    "weighted_contribution": 5.5,
                    "data_available": True,
                    "label": "Historical Percentile",
                },
                "divergence": {
                    "score": 40,
                    "weight": 0.10,
                    "effective_weight": 0.10,
                    "weighted_contribution": 4.0,
                    "data_available": True,
                    "label": "S&P 500 vs Breadth Divergence",
                },
            },
        },
        "components": {
            "breadth_level_trend": {
                "score": 80,
                "signal": "STRONG: test",
                "data_available": True,
                "current_8ma": 0.65,
                "current_200ma": 0.55,
                "trend": 1,
                "level_score": 80,
                "trend_score": 80,
            },
            "ma_crossover": {
                "score": 60,
                "signal": "POSITIVE: test",
                "data_available": True,
                "gap": 0.10,
                "gap_score": 80,
                "ma8_direction": "rising",
                "direction_modifier": 0,
            },
            "cycle_position": {
                "score": 50,
                "signal": "NEUTRAL: test",
                "data_available": True,
            },
            "bearish_signal": {
                "score": 70,
                "signal": "CLEAR: test",
                "data_available": True,
                "signal_active": False,
                "trend": 1,
                "current_8ma": 0.65,
                "in_pink_zone": False,
                "pink_zone_days": 0,
                "base_score": 85,
                "context_adjustment": -15,
            },
            "historical_percentile": {
                "score": 55,
                "signal": "NORMAL: test",
                "data_available": True,
                "current_8ma": 0.65,
                "percentile_rank": 60.0,
                "avg_peak": 0.73,
                "avg_trough": 0.23,
            },
            "divergence": {
                "score": 40,
                "signal": "Mixed signals: test",
                "data_available": True,
                "sp500_pct_change": 2.5,
                "breadth_change": -0.02,
                "divergence_type": "Mixed signals",
            },
        },
        "key_levels": {},
    }
    analysis.update(overrides)
    return analysis


def _generate_to_string(analysis):
    """Generate markdown report and return as string."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        tmp = f.name
    try:
        generate_markdown_report(analysis, tmp)
        with open(tmp) as f:
            return f.read()
    finally:
        os.unlink(tmp)


# =========================================================================
# Step 1 tests: excluded components + Eff. Weight
# =========================================================================


class TestStep1ExcludedComponents:
    def test_eff_weight_column_present(self):
        md = _generate_to_string(_base_analysis())
        assert "Eff. Weight" in md

    def test_excluded_component_marked(self):
        analysis = _base_analysis()
        analysis["composite"]["excluded_components"] = ["Peak/Trough Cycle Position"]
        analysis["composite"]["component_scores"]["cycle_position"]["data_available"] = False
        analysis["composite"]["component_scores"]["cycle_position"]["effective_weight"] = 0.0
        md = _generate_to_string(analysis)
        assert "(excluded)" in md

    def test_excluded_note_displayed(self):
        analysis = _base_analysis()
        analysis["composite"]["excluded_components"] = ["Peak/Trough Cycle Position"]
        analysis["composite"]["component_scores"]["cycle_position"]["data_available"] = False
        md = _generate_to_string(analysis)
        assert "excluded due to insufficient data" in md

    def test_no_excluded_no_note(self):
        md = _generate_to_string(_base_analysis())
        assert "excluded due to insufficient data" not in md

    def test_normal_path_layout_intact(self):
        """All-available path should not break existing layout."""
        md = _generate_to_string(_base_analysis())
        assert "## Component Scores" in md
        assert "## Component Details" in md
        assert "## Key Levels to Watch" in md


# =========================================================================
# Step 2 tests: 8MA direction modifier in C1 details
# =========================================================================


class TestStep2DirectionModifier:
    def test_c1_shows_ma8_direction(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["ma8_direction"] = "rising"
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = 5
        md = _generate_to_string(analysis)
        assert "8MA Direction" in md
        assert "rising" in md

    def test_c1_shows_direction_modifier(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["ma8_direction"] = "falling"
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = -10
        md = _generate_to_string(analysis)
        assert "Direction Modifier" in md
        assert "-10" in md

    def test_c1_omits_modifier_when_zero(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["ma8_direction"] = "rising"
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = 0
        md = _generate_to_string(analysis)
        # Extract C1 section (between "### 1." and "### 2.")
        c1_start = md.index("### 1.")
        c1_end = md.index("### 2.")
        c1_section = md[c1_start:c1_end]
        assert "Direction Modifier" not in c1_section


# =========================================================================
# Step 3 tests: multi-window divergence in C6
# =========================================================================


class TestStep3MultiWindow:
    def test_c6_shows_both_windows(self):
        analysis = _base_analysis()
        analysis["components"]["divergence"]["window_60d"] = {
            "score": 70,
            "divergence_type": "Healthy alignment (both rising)",
            "lookback_days": 60,
        }
        analysis["components"]["divergence"]["window_20d"] = {
            "score": 30,
            "divergence_type": "Consistent decline (both falling)",
            "lookback_days": 20,
        }
        md = _generate_to_string(analysis)
        assert "60-Day Window" in md
        assert "20-Day Window" in md

    def test_c6_shows_early_warning(self):
        analysis = _base_analysis()
        analysis["components"]["divergence"]["window_60d"] = {
            "score": 70,
            "divergence_type": "Healthy",
            "lookback_days": 60,
        }
        analysis["components"]["divergence"]["window_20d"] = {
            "score": 20,
            "divergence_type": "Bearish",
            "lookback_days": 20,
        }
        analysis["components"]["divergence"]["early_warning"] = True
        md = _generate_to_string(analysis)
        assert "Early Warning" in md

    def test_c6_fallback_no_windows(self):
        """Old format without window keys should still render."""
        md = _generate_to_string(_base_analysis())
        assert "S&P 500 vs Breadth Divergence" in md


# =========================================================================
# Step 4 tests: Score Trend section
# =========================================================================


class TestStep4ScoreTrend:
    def test_trend_shown_when_entries_ge_2(self):
        analysis = _base_analysis()
        analysis["trend_summary"] = {
            "entries": [
                {"data_date": "2025-01-13", "composite_score": 55.0},
                {"data_date": "2025-01-14", "composite_score": 60.0},
            ],
            "delta": 5.0,
            "direction": "improving",
        }
        md = _generate_to_string(analysis)
        assert "## Score Trend" in md
        assert "improving" in md.lower() or "Improving" in md

    def test_trend_shown_as_na_when_single_entry(self):
        analysis = _base_analysis()
        analysis["trend_summary"] = {
            "entries": [{"data_date": "2025-01-14", "composite_score": 60.0}],
            "delta": 0,
            "direction": "stable",
        }
        md = _generate_to_string(analysis)
        assert "## Score Trend" in md
        assert "N/A" in md

    def test_trend_omitted_when_zero_entries(self):
        analysis = _base_analysis()
        analysis["trend_summary"] = {
            "entries": [],
            "delta": 0,
            "direction": "stable",
        }
        md = _generate_to_string(analysis)
        assert "## Score Trend" not in md

    def test_trend_omitted_when_missing(self):
        md = _generate_to_string(_base_analysis())
        assert "## Score Trend" not in md


# =========================================================================
# Improvement 2 tests: Guidance caution when direction modifiers negative
# =========================================================================


class TestGuidanceCaution:
    def test_guidance_shows_caution_when_modifiers_negative(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = -10
        analysis["components"]["ma_crossover"]["direction_modifier"] = -10
        md = _generate_to_string(analysis)
        assert "Caution" in md

    def test_guidance_no_caution_when_modifiers_zero(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = 0
        analysis["components"]["ma_crossover"]["direction_modifier"] = 0
        md = _generate_to_string(analysis)
        assert "Caution" not in md

    def test_guidance_caution_when_only_c1_negative(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = -10
        analysis["components"]["ma_crossover"]["direction_modifier"] = 0
        md = _generate_to_string(analysis)
        assert "Caution" in md

    def test_guidance_caution_when_only_c2_negative(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = 0
        analysis["components"]["ma_crossover"]["direction_modifier"] = -10
        md = _generate_to_string(analysis)
        assert "Caution" in md


# =========================================================================
# Condition-dependent actions when Caution fires
# =========================================================================


class TestConditionDependentActions:
    def test_cautionary_actions_injected_when_falling(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = -10
        analysis["components"]["ma_crossover"]["direction_modifier"] = -10
        md = _generate_to_string(analysis)
        assert "Reduce new position sizes" in md
        assert "Tighten stop-loss levels" in md

    def test_no_cautionary_actions_when_healthy(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = 0
        analysis["components"]["ma_crossover"]["direction_modifier"] = 0
        md = _generate_to_string(analysis)
        assert "Reduce new position sizes" not in md
        assert "Tighten stop-loss levels" not in md

    def test_cautionary_actions_when_only_c1_negative(self):
        analysis = _base_analysis()
        analysis["components"]["breadth_level_trend"]["direction_modifier"] = -10
        analysis["components"]["ma_crossover"]["direction_modifier"] = 0
        md = _generate_to_string(analysis)
        assert "Reduce new position sizes" in md


# =========================================================================
# C6 score displays as int (not float)
# =========================================================================


class TestC6ScoreIntDisplay:
    def test_c6_float_score_renders_as_int(self):
        analysis = _base_analysis()
        analysis["composite"]["component_scores"]["divergence"]["score"] = 62.0
        md = _generate_to_string(analysis)
        # Should show "62" not "62.0" in the score column
        assert " 62.0 " not in md
        assert " 62 " in md

    def test_integer_scores_unchanged(self):
        analysis = _base_analysis()
        md = _generate_to_string(analysis)
        # C1 score=80 should still appear as 80
        assert " 80 " in md
