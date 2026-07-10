"""Normalization and lightweight schema validation for hypothesis ideation input."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

OPTIONAL_DEFAULTS = {
    "performance_summary": None,
    "trade_log_summary": None,
    "feature_inventory": [],
    "journal_snippets": [],
    "qualitative_notes": [],
    "artifacts": [],
}

RAW_HYPOTHESIS_REQUIRED_FIELDS = (
    "hypothesis_id",
    "title",
    "thesis",
    "problem_target",
    "mechanism",
    "evidence_basis",
    "proposed_rule_changes",
    "expected_impact",
    "key_risks",
    "kill_criteria",
    "minimum_viable_experiment",
    "score_components",
    "priority_score",
    "recommendation",
    "rationale",
    "confidence",
    "assumptions",
    "dependencies",
)

_ALLOWED_RECOMMENDATIONS = {"pursue", "park", "reject"}
_SCORE_KEYS = (
    "evidence_strength",
    "mechanism_clarity",
    "feasibility",
    "expected_payoff",
    "novelty",
    "test_efficiency",
)


def validate_input(data: dict) -> list[str]:
    """Validate required input fields and minimal typing constraints."""
    errors: list[str] = []

    if not isinstance(data, dict):
        return ["input must be a JSON object"]

    objective = data.get("objective")
    if not isinstance(objective, dict):
        errors.append("objective must be an object")
    else:
        _require_non_empty_string(objective, "goal", errors, "objective.goal")
        _require_non_empty_string(objective, "focus_area", errors, "objective.focus_area")

    strategy_context = data.get("strategy_context")
    if not isinstance(strategy_context, dict):
        errors.append("strategy_context must be an object")
    else:
        _require_non_empty_string(
            strategy_context,
            "strategy_name",
            errors,
            "strategy_context.strategy_name",
        )
        _require_non_empty_string(strategy_context, "summary", errors, "strategy_context.summary")

    constraints = data.get("constraints")
    if not isinstance(constraints, dict):
        errors.append("constraints must be an object")
    else:
        _require_list(
            constraints, "execution_constraints", errors, "constraints.execution_constraints"
        )
        _require_list(constraints, "risk_constraints", errors, "constraints.risk_constraints")

    market_context = data.get("market_context")
    if not isinstance(market_context, dict):
        errors.append("market_context must be an object")
    else:
        _require_non_empty_string(market_context, "summary", errors, "market_context.summary")

    return errors


def fill_defaults(data: dict) -> dict:
    """Fill optional fields without mutating the caller-owned object."""
    normalized = deepcopy(data)
    for key, default_value in OPTIONAL_DEFAULTS.items():
        if key not in normalized:
            normalized[key] = deepcopy(default_value)
    return normalized


def normalize(data: dict) -> tuple[dict, list[str]]:
    """Validate input and return a default-filled normalized payload."""
    errors = validate_input(data)
    normalized = fill_defaults(data if isinstance(data, dict) else {})
    return normalized, errors


def validate_raw_hypotheses(payload: dict[str, Any]) -> list[str]:
    """Validate Pass 2 raw hypotheses payload (`--hypotheses`)."""
    errors: list[str] = []

    if not isinstance(payload, dict):
        return ["raw hypotheses payload must be a JSON object"]

    extra_keys = sorted(set(payload.keys()) - {"hypotheses"})
    if extra_keys:
        errors.append(f"raw hypotheses payload has unexpected keys: {', '.join(extra_keys)}")

    hypotheses = payload.get("hypotheses")
    if hypotheses is None:
        errors.append("hypotheses key is required")
        return errors

    if not isinstance(hypotheses, list):
        errors.append("hypotheses must be an array")
        return errors

    if not (1 <= len(hypotheses) <= 5):
        errors.append("hypotheses must contain 1-5 cards")

    for idx, card in enumerate(hypotheses):
        prefix = f"hypotheses[{idx}]"

        if not isinstance(card, dict):
            errors.append(f"{prefix} must be an object")
            continue

        for field in RAW_HYPOTHESIS_REQUIRED_FIELDS:
            if field not in card:
                errors.append(f"{prefix}.{field} is required")

        recommendation = card.get("recommendation")
        if recommendation not in _ALLOWED_RECOMMENDATIONS:
            errors.append(
                f"{prefix}.recommendation must be one of: {', '.join(sorted(_ALLOWED_RECOMMENDATIONS))}"
            )

        evidence_basis = card.get("evidence_basis")
        if not isinstance(evidence_basis, list) or len(evidence_basis) < 1:
            errors.append(f"{prefix}.evidence_basis must be a non-empty list")

        kill_criteria = card.get("kill_criteria")
        if not isinstance(kill_criteria, list) or len(kill_criteria) < 1:
            errors.append(f"{prefix}.kill_criteria must be a non-empty list")

        minimum_viable_experiment = card.get("minimum_viable_experiment")
        if not isinstance(minimum_viable_experiment, dict):
            errors.append(f"{prefix}.minimum_viable_experiment must be an object")
        else:
            for sub_key in ("goal", "setup", "metrics", "sample_size", "duration"):
                if sub_key not in minimum_viable_experiment:
                    errors.append(f"{prefix}.minimum_viable_experiment.{sub_key} is required")

        score_components = card.get("score_components")
        if not isinstance(score_components, dict):
            errors.append(f"{prefix}.score_components must be an object")
            continue

        for score_key in _SCORE_KEYS:
            if score_key not in score_components:
                errors.append(f"{prefix}.score_components.{score_key} is required")
                continue

            score_value = score_components[score_key]
            if not _is_number(score_value) or not (1 <= float(score_value) <= 5):
                errors.append(f"{prefix}.score_components.{score_key} must be in [1, 5]")

    return errors


def _require_non_empty_string(
    payload: dict[str, Any],
    key: str,
    errors: list[str],
    label: str,
) -> None:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{label} must be a non-empty string")


def _require_list(payload: dict[str, Any], key: str, errors: list[str], label: str) -> None:
    value = payload.get(key)
    if not isinstance(value, list):
        errors.append(f"{label} must be a list")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
