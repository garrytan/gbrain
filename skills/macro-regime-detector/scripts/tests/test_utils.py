"""Tests for determine_direction utility function"""

from calculators.utils import determine_direction


class TestDetermineDirection:
    def test_recent_golden_cross_confirmed(self):
        """Recent golden cross with positive ROC → positive label, confirmed."""
        crossover = {"type": "golden_cross", "bars_ago": 1}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=5.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_on"
        assert qualifier == "confirmed"

    def test_recent_death_cross_confirmed(self):
        """Recent death cross with negative ROC → negative label, confirmed."""
        crossover = {"type": "death_cross", "bars_ago": 1}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=-3.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_off"
        assert qualifier == "confirmed"

    def test_stale_golden_cross_reversing(self):
        """5-month-old golden cross with negative ROC → momentum overrides to negative."""
        crossover = {"type": "golden_cross", "bars_ago": 5}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=-13.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_off"
        assert qualifier == "reversing"

    def test_stale_death_cross_reversing(self):
        """Old death cross with positive ROC → momentum overrides to positive."""
        crossover = {"type": "death_cross", "bars_ago": 4}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=5.0,
            positive_label="easing",
            negative_label="tightening",
        )
        assert direction == "easing"
        assert qualifier == "reversing"

    def test_stale_golden_cross_confirmed(self):
        """Old golden cross but still positive ROC → positive label, confirmed."""
        crossover = {"type": "golden_cross", "bars_ago": 5}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=2.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_on"
        assert qualifier == "confirmed"

    def test_recent_cross_fading(self):
        """Recent golden cross but negative ROC (not stale) → positive, fading."""
        crossover = {"type": "golden_cross", "bars_ago": 1}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=-2.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_on"
        assert qualifier == "fading"

    def test_no_crossover_momentum_only(self):
        """No crossover, positive ROC → positive from momentum."""
        crossover = {"type": "none", "bars_ago": None}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=3.0,
            positive_label="small_cap_leading",
            negative_label="large_cap_leading",
        )
        assert direction == "small_cap_leading"
        assert qualifier == "N/A"

    def test_no_crossover_no_roc_neutral(self):
        """No crossover, no ROC → neutral."""
        crossover = {"type": "none", "bars_ago": None}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=None,
            positive_label="risk_on",
            negative_label="risk_off",
            neutral_label="neutral",
        )
        assert direction == "neutral"
        assert qualifier == "N/A"

    def test_converging_with_momentum(self):
        """Converging (not a cross) with positive momentum → positive from momentum."""
        crossover = {"type": "converging", "bars_ago": None}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=4.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_on"
        assert qualifier == "N/A"

    def test_custom_neutral_label(self):
        """Custom neutral label returned when no signals."""
        crossover = {"type": "none", "bars_ago": None}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=None,
            positive_label="easing",
            negative_label="tightening",
            neutral_label="stable",
        )
        assert direction == "stable"

    def test_stale_threshold_boundary(self):
        """bars_ago == 3 (exactly at threshold) is stale."""
        crossover = {"type": "golden_cross", "bars_ago": 3}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=-5.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_off"
        assert qualifier == "reversing"

    def test_bars_ago_just_below_threshold(self):
        """bars_ago == 2 (below threshold) is NOT stale → recent cross wins."""
        crossover = {"type": "golden_cross", "bars_ago": 2}
        direction, qualifier = determine_direction(
            crossover,
            roc_3m=-5.0,
            positive_label="risk_on",
            negative_label="risk_off",
        )
        assert direction == "risk_on"
        assert qualifier == "fading"
