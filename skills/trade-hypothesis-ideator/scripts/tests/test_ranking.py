"""Tests for ranking helpers (Step F)."""

from __future__ import annotations

from copy import deepcopy

import pytest
from pipeline.ranking import (
    REQUIRED_SCORE_KEYS,
    SCORING_WEIGHTS,
    compute_priority_score,
    rank_hypotheses,
    validate_score_components,
)


def test_scoring_weights_sum_to_one() -> None:
    assert sum(SCORING_WEIGHTS.values()) == pytest.approx(1.0)


def test_compute_priority_score_all_five() -> None:
    scores = {key: 5 for key in REQUIRED_SCORE_KEYS}
    assert compute_priority_score(scores) == 5.0


def test_compute_priority_score_all_one() -> None:
    scores = {key: 1 for key in REQUIRED_SCORE_KEYS}
    assert compute_priority_score(scores) == 1.0


def test_compute_priority_score_example_h001_components() -> None:
    scores = {
        "evidence_strength": 5,
        "mechanism_clarity": 5,
        "feasibility": 5,
        "expected_payoff": 4,
        "novelty": 3,
        "test_efficiency": 5,
    }
    assert compute_priority_score(scores) == pytest.approx(4.65, abs=0.01)


def test_rank_hypotheses_sorts_by_priority_score_descending(example_output: dict) -> None:
    card_a = deepcopy(example_output["hypotheses"][0])
    card_a["hypothesis_id"] = "H-A"

    card_b = deepcopy(card_a)
    card_b["hypothesis_id"] = "H-B"
    card_b["score_components"] = {
        "evidence_strength": 2,
        "mechanism_clarity": 2,
        "feasibility": 2,
        "expected_payoff": 2,
        "novelty": 2,
        "test_efficiency": 2,
    }

    ranked = rank_hypotheses([card_b, card_a])

    assert ranked[0]["hypothesis_id"] == "H-A"
    assert ranked[1]["hypothesis_id"] == "H-B"
    assert ranked[0]["priority_score"] > ranked[1]["priority_score"]


def test_validate_score_components_reports_missing_key() -> None:
    scores = {key: 3 for key in REQUIRED_SCORE_KEYS if key != "novelty"}

    errors = validate_score_components(scores)

    assert errors
    assert any("missing" in err for err in errors)


def test_validate_score_components_rejects_zero() -> None:
    scores = {key: 3 for key in REQUIRED_SCORE_KEYS}
    scores["novelty"] = 0

    errors = validate_score_components(scores)

    assert errors
    assert any("[1, 5]" in err for err in errors)


def test_validate_score_components_rejects_six() -> None:
    scores = {key: 3 for key in REQUIRED_SCORE_KEYS}
    scores["novelty"] = 6

    errors = validate_score_components(scores)

    assert errors
    assert any("[1, 5]" in err for err in errors)


def test_rank_hypotheses_raises_value_error_for_invalid_scores(base_hypothesis_card: dict) -> None:
    bad = deepcopy(base_hypothesis_card)
    bad["score_components"]["novelty"] = 9

    with pytest.raises(ValueError, match="invalid score_components"):
        rank_hypotheses([bad])
