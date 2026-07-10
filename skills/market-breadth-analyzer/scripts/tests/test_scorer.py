"""Tests for the composite scoring engine."""

from scorer import COMPONENT_WEIGHTS, calculate_composite_score


def _all_scores(value=50):
    """Return component_scores dict with all components set to *value*."""
    return {k: value for k in COMPONENT_WEIGHTS}


def _all_available():
    return {k: True for k in COMPONENT_WEIGHTS}


def _all_unavailable():
    return {k: False for k in COMPONENT_WEIGHTS}


class TestWeightRedistribution:
    """When a component is data_available=False, its weight is redistributed."""

    def test_all_available_uses_original_weights(self):
        scores = _all_scores(60)
        result = calculate_composite_score(scores, _all_available())
        assert result["composite_score"] == 60.0

    def test_one_excluded_redistributes_weight(self):
        """Excluding cycle_position (weight 0.20) redistributes to remaining."""
        scores = _all_scores(60)
        avail = _all_available()
        avail["cycle_position"] = False

        result = calculate_composite_score(scores, avail)
        # All remaining scores are 60, so composite should still be 60
        assert result["composite_score"] == 60.0

    def test_excluded_component_different_score(self):
        """Excluding a low-scoring component raises the composite."""
        scores = _all_scores(80)
        scores["cycle_position"] = 20  # Low score
        avail = _all_available()
        avail["cycle_position"] = False

        result = calculate_composite_score(scores, avail)
        # cycle_position excluded, so 20 is ignored; rest are 80
        assert result["composite_score"] == 80.0

    def test_effective_weights_sum_to_one(self):
        scores = _all_scores(50)
        avail = _all_available()
        avail["divergence"] = False
        avail["historical_percentile"] = False

        result = calculate_composite_score(scores, avail)
        total_eff = sum(
            c["effective_weight"]
            for c in result["component_scores"].values()
            if c.get("data_available", True)
        )
        assert abs(total_eff - 1.0) < 1e-9

    def test_excluded_components_listed(self):
        scores = _all_scores(50)
        avail = _all_available()
        avail["cycle_position"] = False

        result = calculate_composite_score(scores, avail)
        assert "Peak/Trough Cycle Position" in result["excluded_components"]

    def test_all_unavailable_returns_neutral(self):
        """All components unavailable -> score=50, zone=Neutral, warning."""
        scores = _all_scores(70)
        result = calculate_composite_score(scores, _all_unavailable())
        assert result["composite_score"] == 50.0
        assert result["zone"] == "Neutral"
        assert len(result["excluded_components"]) == 6

    def test_strongest_weakest_exclude_unavailable(self):
        """strongest/weakest should only consider available components."""
        scores = {
            "breadth_level_trend": 90,
            "ma_crossover": 30,
            "cycle_position": 10,  # lowest but unavailable
            "bearish_signal": 70,
            "historical_percentile": 50,
            "divergence": 80,
        }
        avail = _all_available()
        avail["cycle_position"] = False

        result = calculate_composite_score(scores, avail)
        assert result["strongest_health"]["component"] == "breadth_level_trend"
        assert result["weakest_health"]["component"] == "ma_crossover"

    def test_backward_compat_no_data_availability(self):
        """When data_availability is None, all components treated as available."""
        scores = _all_scores(60)
        result = calculate_composite_score(scores)
        assert result["composite_score"] == 60.0
        assert len(result.get("excluded_components", [])) == 0

    def test_component_scores_have_effective_weight(self):
        scores = _all_scores(50)
        result = calculate_composite_score(scores, _all_available())
        for _key, comp in result["component_scores"].items():
            assert "effective_weight" in comp
            assert "data_available" in comp

    def test_excluded_component_has_zero_effective_weight(self):
        scores = _all_scores(50)
        avail = _all_available()
        avail["divergence"] = False
        result = calculate_composite_score(scores, avail)
        assert result["component_scores"]["divergence"]["effective_weight"] == 0.0
