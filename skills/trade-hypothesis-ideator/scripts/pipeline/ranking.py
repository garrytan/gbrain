"""Priority scoring and ranking for hypothesis cards (Step F)."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

SCORING_WEIGHTS = {
    "evidence_strength": 0.25,
    "mechanism_clarity": 0.20,
    "feasibility": 0.20,
    "expected_payoff": 0.15,
    "novelty": 0.10,
    "test_efficiency": 0.10,
}

REQUIRED_SCORE_KEYS = frozenset(SCORING_WEIGHTS.keys())


def validate_score_components(scores: dict) -> list[str]:
    """Validate score_components presence, key set, and numeric ranges."""
    errors: list[str] = []

    if not isinstance(scores, dict):
        return ["score_components must be a mapping"]

    present = set(scores.keys())
    missing = sorted(REQUIRED_SCORE_KEYS - present)
    unexpected = sorted(present - REQUIRED_SCORE_KEYS)

    if missing:
        errors.append(f"score_components missing keys: {', '.join(missing)}")
    if unexpected:
        errors.append(f"score_components has unexpected keys: {', '.join(unexpected)}")

    for key in REQUIRED_SCORE_KEYS.intersection(present):
        value = scores[key]
        if not _is_number(value) or not (1 <= float(value) <= 5):
            errors.append(f"score_components.{key} must be in [1, 5]")

    return errors


def compute_priority_score(score_components: dict[str, float]) -> float:
    """Compute weighted average score and round to two decimal places."""
    errors = validate_score_components(score_components)
    if errors:
        raise ValueError("invalid score_components: " + "; ".join(errors))

    weighted_sum = sum(float(score_components[k]) * SCORING_WEIGHTS[k] for k in REQUIRED_SCORE_KEYS)
    return round(weighted_sum, 2)


def rank_hypotheses(hypotheses: list[dict]) -> list[dict]:
    """Compute priority_score for each hypothesis and return descending order."""
    ranked: list[dict] = []

    for idx, hypothesis in enumerate(hypotheses):
        if not isinstance(hypothesis, dict):
            raise ValueError(f"invalid hypothesis at index {idx}: must be an object")

        score_components = hypothesis.get("score_components")
        errors = validate_score_components(score_components)
        if errors:
            hypothesis_id = hypothesis.get("hypothesis_id", f"idx-{idx}")
            raise ValueError(f"invalid score_components for {hypothesis_id}: " + "; ".join(errors))

        row = deepcopy(hypothesis)
        row["priority_score"] = compute_priority_score(score_components)
        ranked.append(row)

    ranked.sort(key=lambda x: x["priority_score"], reverse=True)
    return ranked


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
