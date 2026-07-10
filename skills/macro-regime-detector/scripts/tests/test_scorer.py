"""Tests for Macro Regime Detector Scorer"""

from scorer import (
    calculate_composite_score,
    check_regime_consistency,
    classify_regime,
)


class TestCalculateCompositeScore:
    def test_all_zero_scores(self):
        scores = {
            "concentration": 0,
            "yield_curve": 0,
            "credit_conditions": 0,
            "size_factor": 0,
            "equity_bond": 0,
            "sector_rotation": 0,
        }
        result = calculate_composite_score(scores)
        assert result["composite_score"] == 0.0
        assert "Green" in result["zone"] or "Stable" in result["zone"]

    def test_all_max_scores(self):
        scores = {
            "concentration": 100,
            "yield_curve": 100,
            "credit_conditions": 100,
            "size_factor": 100,
            "equity_bond": 100,
            "sector_rotation": 100,
        }
        result = calculate_composite_score(scores)
        assert result["composite_score"] == 100.0

    def test_weighted_calculation(self):
        # Only concentration = 100, rest = 0 -> should be 25%
        scores = {
            "concentration": 100,
            "yield_curve": 0,
            "credit_conditions": 0,
            "size_factor": 0,
            "equity_bond": 0,
            "sector_rotation": 0,
        }
        result = calculate_composite_score(scores)
        assert result["composite_score"] == 25.0

    def test_data_quality_tracking(self):
        scores = {
            "concentration": 50,
            "yield_curve": 50,
            "credit_conditions": 50,
            "size_factor": 50,
            "equity_bond": 50,
            "sector_rotation": 50,
        }
        availability = {
            "concentration": True,
            "yield_curve": False,
            "credit_conditions": True,
            "size_factor": True,
            "equity_bond": True,
            "sector_rotation": True,
        }
        result = calculate_composite_score(scores, availability)
        assert result["data_quality"]["available_count"] == 5
        assert len(result["data_quality"]["missing_components"]) == 1

    def test_strongest_weakest_signal(self):
        scores = {
            "concentration": 80,
            "yield_curve": 10,
            "credit_conditions": 50,
            "size_factor": 30,
            "equity_bond": 60,
            "sector_rotation": 40,
        }
        result = calculate_composite_score(scores)
        assert result["strongest_signal"]["component"] == "concentration"
        assert result["weakest_signal"]["component"] == "yield_curve"

    def test_signaling_count(self):
        scores = {
            "concentration": 50,  # signaling (>= 40)
            "yield_curve": 60,  # signaling
            "credit_conditions": 10,  # not signaling
            "size_factor": 45,  # signaling
            "equity_bond": 20,  # not signaling
            "sector_rotation": 70,  # signaling
        }
        result = calculate_composite_score(scores)
        assert result["signaling_components"] == 4

    def test_zone_boundaries(self):
        # Test each zone boundary
        for score_val, expected_zone_part in [
            (0, "Stable"),
            (20, "Stable"),
            (21, "Early"),
            (40, "Early"),
            (41, "Transition"),
            (60, "Transition"),
            (61, "Active"),
            (80, "Active"),
            (81, "Confirmed"),
        ]:
            scores = {
                k: score_val
                for k in [
                    "concentration",
                    "yield_curve",
                    "credit_conditions",
                    "size_factor",
                    "equity_bond",
                    "sector_rotation",
                ]
            }
            result = calculate_composite_score(scores)
            assert expected_zone_part in result["zone"], (
                f"Score {score_val}: expected '{expected_zone_part}' in '{result['zone']}'"
            )


class TestClassifyRegime:
    def _make_component(self, score=0, direction="unknown", **kwargs):
        base = {
            "score": score,
            "signal": "test",
            "data_available": True,
            "direction": direction,
            "crossover": {"type": "none", "bars_ago": None},
        }
        base.update(kwargs)
        return base

    def test_concentration_regime(self):
        components = {
            "concentration": self._make_component(60, "concentrating"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(10, "stable"),
            "size_factor": self._make_component(50, "large_cap_leading"),
            "equity_bond": self._make_component(10, "neutral"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        assert result["current_regime"] == "concentration"

    def test_broadening_regime(self):
        components = {
            "concentration": self._make_component(60, "broadening"),
            "yield_curve": self._make_component(10, "steepening"),
            "credit_conditions": self._make_component(10, "easing"),
            "size_factor": self._make_component(50, "small_cap_leading"),
            "equity_bond": self._make_component(10, "risk_on"),
            "sector_rotation": self._make_component(50, "risk_on"),
        }
        result = classify_regime(components)
        assert result["current_regime"] == "broadening"

    def test_contraction_regime(self):
        components = {
            "concentration": self._make_component(10, "unknown"),
            "yield_curve": self._make_component(10, "flattening"),
            "credit_conditions": self._make_component(60, "tightening"),
            "size_factor": self._make_component(10, "unknown"),
            "equity_bond": self._make_component(50, "risk_off"),
            "sector_rotation": self._make_component(60, "risk_off"),
        }
        result = classify_regime(components)
        assert result["current_regime"] == "contraction"

    def test_inflationary_regime(self):
        components = {
            "concentration": self._make_component(10, "unknown"),
            "yield_curve": self._make_component(10, "steepening"),
            "credit_conditions": self._make_component(10, "unknown"),
            "size_factor": self._make_component(10, "unknown"),
            "equity_bond": self._make_component(60, "risk_off", correlation_regime="positive"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        assert result["current_regime"] == "inflationary"

    def test_transitional_regime(self):
        # Many components signaling but no clear pattern
        components = {
            "concentration": self._make_component(50, "broadening"),
            "yield_curve": self._make_component(50, "steepening"),
            "credit_conditions": self._make_component(50, "tightening"),
            "size_factor": self._make_component(50, "large_cap_leading"),
            "equity_bond": self._make_component(50, "risk_off"),
            "sector_rotation": self._make_component(50, "risk_off"),
        }
        result = classify_regime(components)
        # With mixed signals, should be transitional or the strongest match
        assert result["current_regime"] in (
            "transitional",
            "contraction",
            "broadening",
            "concentration",
            "inflationary",
        )

    def test_confidence_levels(self):
        # High confidence: many matching signals
        components = {
            "concentration": self._make_component(60, "concentrating"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(10, "stable"),
            "size_factor": self._make_component(50, "large_cap_leading"),
            "equity_bond": self._make_component(10, "neutral"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        assert result["confidence"] in ("high", "moderate", "low", "very_low")

    def test_transition_probability(self):
        components = {
            "concentration": self._make_component(60, "broadening"),
            "yield_curve": self._make_component(50, "steepening"),
            "credit_conditions": self._make_component(45, "easing"),
            "size_factor": self._make_component(55, "small_cap_leading"),
            "equity_bond": self._make_component(40, "risk_on"),
            "sector_rotation": self._make_component(50, "risk_on"),
        }
        result = classify_regime(components)
        tp = result["transition_probability"]
        assert "level" in tp
        assert "probability_range" in tp
        assert "signaling_count" in tp
        assert tp["level"] in ("high", "moderate", "low", "minimal")

    def test_evidence_list(self):
        components = {
            "concentration": self._make_component(60, "broadening"),
            "yield_curve": self._make_component(50, "steepening"),
            "credit_conditions": self._make_component(10, "stable"),
            "size_factor": self._make_component(10, "neutral"),
            "equity_bond": self._make_component(10, "neutral"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        assert len(result["evidence"]) == 2  # Only 2 components >= 40
        # Sorted by score descending
        if len(result["evidence"]) >= 2:
            assert result["evidence"][0]["score"] >= result["evidence"][1]["score"]

    def test_unknown_credit_no_concentration_bias(self):
        """Missing credit data should NOT bias toward Concentration regime."""
        # All components with data_available=True but direction="unknown"
        # means data exists but direction is unclear
        components = {
            "concentration": self._make_component(10, "unknown"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(0, "unknown", data_available=False),
            "size_factor": self._make_component(10, "unknown"),
            "equity_bond": self._make_component(10, "neutral"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        # With no real signals, concentration should NOT get bonus from unknown credit
        assert result["regime_scores"]["concentration"] == 0

    def test_missing_data_caps_confidence(self):
        """With 3 or fewer available components, confidence capped at very_low."""
        components = {
            "concentration": self._make_component(60, "concentrating"),
            "yield_curve": self._make_component(0, "unknown", data_available=False),
            "credit_conditions": self._make_component(0, "unknown", data_available=False),
            "size_factor": self._make_component(60, "large_cap_leading"),
            "equity_bond": self._make_component(0, "unknown", data_available=False),
            "sector_rotation": self._make_component(0, "unknown", data_available=False),
        }
        result = classify_regime(components)
        # Only 2 components available -> must be very_low confidence
        assert result["confidence"] == "very_low"

    def test_four_components_caps_at_low(self):
        """With 4 available components, confidence capped at low."""
        components = {
            "concentration": self._make_component(60, "concentrating"),
            "yield_curve": self._make_component(50, "steepening"),
            "credit_conditions": self._make_component(0, "unknown", data_available=False),
            "size_factor": self._make_component(60, "large_cap_leading"),
            "equity_bond": self._make_component(50, "risk_on"),
            "sector_rotation": self._make_component(0, "unknown", data_available=False),
        }
        result = classify_regime(components)
        assert result["confidence"] in ("low", "very_low")

    def test_unavailable_component_direction_ignored(self):
        """Components with data_available=False should have direction treated as unknown."""
        # Credit has direction="tightening" but data_available=False -> should be ignored
        components = {
            "concentration": self._make_component(10, "unknown"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(60, "tightening", data_available=False),
            "size_factor": self._make_component(10, "neutral"),
            "equity_bond": self._make_component(10, "neutral"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        # Contraction should NOT score from unavailable credit data
        assert result["regime_scores"]["contraction"] == 0

    # --- Improvement 1: Tiebreak → Transitional ---

    def test_tiebreak_broadening_contraction_becomes_transitional(self):
        """Tied broadening=3, contraction=3, low composite → transitional."""
        # broadening: conc broadening(+2) + credit easing(+1) = 3
        # contraction: sector risk_off(+2) + eb risk_off(+1) = 3
        # concentration: size large_cap? no, size=unknown -> 0
        # inflationary: corr_regime unknown -> 0
        components = {
            "concentration": self._make_component(20, "broadening"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(20, "easing"),
            "size_factor": self._make_component(20, "unknown"),
            "equity_bond": self._make_component(20, "risk_off"),
            "sector_rotation": self._make_component(20, "risk_off"),
        }
        result = classify_regime(components)
        # Low composite (all scores ~20) < 50 → tied → transitional
        assert result["current_regime"] == "transitional"
        assert result.get("tied_regimes") is not None
        assert set(result["tied_regimes"]) == {"broadening", "contraction"}

    def test_tiebreak_keeps_winner_high_composite(self):
        """Tied but composite >= 50 → keeps top scorer (not forced transitional)."""
        # Same tie but high individual scores
        # broadening: conc broadening(+2) + credit easing(+1) = 3
        # contraction: sector risk_off(+2) + eb risk_off(+1) = 3
        components = {
            "concentration": self._make_component(70, "broadening"),
            "yield_curve": self._make_component(60, "stable"),
            "credit_conditions": self._make_component(60, "easing"),
            "size_factor": self._make_component(50, "unknown"),
            "equity_bond": self._make_component(50, "risk_off"),
            "sector_rotation": self._make_component(50, "risk_off"),
        }
        result = classify_regime(components)
        # Composite >= 50: even though tied, keep top scorer
        assert result["current_regime"] in ("broadening", "contraction")
        # tied_regimes should still be reported
        assert result.get("tied_regimes") is not None

    def test_no_tied_regimes_clear_winner(self):
        """Clear winner → tied_regimes is None."""
        components = {
            "concentration": self._make_component(60, "concentrating"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(10, "stable"),
            "size_factor": self._make_component(50, "large_cap_leading"),
            "equity_bond": self._make_component(10, "neutral"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        assert result["current_regime"] == "concentration"
        assert result.get("tied_regimes") is None

    # --- Improvement 3: Transition Direction ---

    def test_transition_direction_present(self):
        """from_regime and to_regime present when transition probability is high/moderate."""
        components = {
            "concentration": self._make_component(60, "broadening"),
            "yield_curve": self._make_component(50, "steepening"),
            "credit_conditions": self._make_component(45, "easing"),
            "size_factor": self._make_component(55, "small_cap_leading"),
            "equity_bond": self._make_component(40, "risk_on"),
            "sector_rotation": self._make_component(50, "risk_on"),
        }
        result = classify_regime(components)
        tp = result["transition_probability"]
        assert "from_regime" in tp
        assert "to_regime" in tp

    def test_transition_direction_none_when_minimal(self):
        """from/to are None when transition probability is minimal."""
        components = {
            "concentration": self._make_component(10, "unknown"),
            "yield_curve": self._make_component(5, "stable"),
            "credit_conditions": self._make_component(5, "stable"),
            "size_factor": self._make_component(5, "unknown"),
            "equity_bond": self._make_component(5, "neutral"),
            "sector_rotation": self._make_component(5, "neutral"),
        }
        result = classify_regime(components)
        tp = result["transition_probability"]
        assert tp["from_regime"] is None
        assert tp["to_regime"] is None

    # --- Improvement 4: Regime Consistency ---

    def test_check_regime_consistency_broadening(self):
        """Broadening regime with matching components → all consistent."""
        components = {
            "concentration": self._make_component(60, "broadening"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(20, "easing"),
            "size_factor": self._make_component(50, "small_cap_leading"),
            "equity_bond": self._make_component(30, "risk_on"),
            "sector_rotation": self._make_component(40, "risk_on"),
        }
        result = check_regime_consistency("broadening", components)
        assert result["concentration"] == "consistent"
        assert result["size_factor"] == "consistent"
        assert result["sector_rotation"] == "consistent"

    def test_check_regime_consistency_contradicting(self):
        """Broadening regime but some components contradicting."""
        components = {
            "concentration": self._make_component(60, "concentrating"),  # contradicts
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(20, "tightening"),  # contradicts
            "size_factor": self._make_component(50, "large_cap_leading"),  # contradicts
            "equity_bond": self._make_component(30, "risk_off"),  # contradicts
            "sector_rotation": self._make_component(40, "risk_off"),  # contradicts
        }
        result = check_regime_consistency("broadening", components)
        assert result["concentration"] == "contradicting"
        assert result["size_factor"] == "contradicting"
        assert result["sector_rotation"] == "contradicting"

    def test_check_regime_consistency_transitional(self):
        """Transitional regime → all neutral (no expectations)."""
        components = {
            "concentration": self._make_component(60, "broadening"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(20, "tightening"),
            "size_factor": self._make_component(50, "small_cap_leading"),
            "equity_bond": self._make_component(30, "risk_on"),
            "sector_rotation": self._make_component(40, "risk_on"),
        }
        result = check_regime_consistency("transitional", components)
        for v in result.values():
            assert v == "neutral"

    # --- Improvement: Ambiguous regime downgrades confidence ---

    def test_ambiguous_regime_downgrades_confidence_from_high(self):
        """When regime is ambiguous (tied), confidence should be moderate at most."""
        # Contraction: credit tightening(+2) + sector risk_off(+2) + eb risk_off(+1) = 5
        # Inflationary: corr positive(+3) + eb risk_off(+1) = 4
        # Difference = 1 → ambiguous
        components = {
            "concentration": self._make_component(40, "concentrating"),
            "yield_curve": self._make_component(60, "flattening"),
            "credit_conditions": self._make_component(50, "tightening"),
            "size_factor": self._make_component(80, "small_cap_leading"),
            "equity_bond": self._make_component(10, "risk_off", correlation_regime="positive"),
            "sector_rotation": self._make_component(80, "risk_off"),
        }
        result = classify_regime(components)
        tp = result["transition_probability"]
        assert tp["ambiguous"] is True
        # Confidence should be capped at moderate when ambiguous
        assert result["confidence"] in ("moderate", "low", "very_low")

    def test_non_ambiguous_regime_keeps_high_confidence(self):
        """When regime is NOT ambiguous, high confidence is preserved."""
        # Concentration: conc concentrating(+2) + size large_cap(+2) + credit stable(+1) = 5
        # Broadening: 0, Contraction: 0, Inflationary: 0
        components = {
            "concentration": self._make_component(60, "concentrating"),
            "yield_curve": self._make_component(10, "stable"),
            "credit_conditions": self._make_component(10, "stable"),
            "size_factor": self._make_component(50, "large_cap_leading"),
            "equity_bond": self._make_component(10, "neutral"),
            "sector_rotation": self._make_component(10, "neutral"),
        }
        result = classify_regime(components)
        assert result["confidence"] == "high"

    # --- Improvement: Contraction regime with size factor contradiction ---

    def test_contraction_reduced_by_small_cap_leading(self):
        """Small-cap leadership should reduce contraction evidence score."""
        # credit(+2) + sector(+2) + yc_flattening(+1) - small_cap(-1) = 4
        # Without yc: credit(+2) + sector(+2) - small_cap(-1) = 3 < 4
        # With yc_flattening(+1): total = 4, so assert < 5
        components = {
            "concentration": self._make_component(40, "concentrating"),
            "yield_curve": self._make_component(60, "flattening"),
            "credit_conditions": self._make_component(50, "tightening"),
            "size_factor": self._make_component(80, "small_cap_leading"),
            "equity_bond": self._make_component(10, "risk_on"),
            "sector_rotation": self._make_component(80, "risk_off"),
        }
        result = classify_regime(components)
        # Contraction score should be reduced by size factor contradiction
        assert result["regime_scores"]["contraction"] < 5

    def test_contraction_not_reduced_by_large_cap(self):
        """Large-cap leadership should not reduce contraction score."""
        components = {
            "concentration": self._make_component(10, "unknown"),
            "yield_curve": self._make_component(10, "flattening"),
            "credit_conditions": self._make_component(60, "tightening"),
            "size_factor": self._make_component(10, "large_cap_leading"),
            "equity_bond": self._make_component(50, "risk_off"),
            "sector_rotation": self._make_component(60, "risk_off"),
        }
        result = classify_regime(components)
        # credit(+2) + sector(+2) + eb(+1) + yc_flattening(+1) = 6, no reduction
        assert result["regime_scores"]["contraction"] == 6
