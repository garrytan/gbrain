"""Tests for Step A normalization helpers."""

from __future__ import annotations

from copy import deepcopy

from pipeline.normalize import fill_defaults, normalize, validate_input, validate_raw_hypotheses


def test_validate_input_accepts_example_input(example_input: dict) -> None:
    errors = validate_input(example_input)
    assert errors == []


def test_validate_input_missing_objective_reports_error(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload.pop("objective")

    errors = validate_input(payload)

    assert errors
    assert any("objective" in err for err in errors)


def test_validate_input_missing_strategy_name_reports_error(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload["strategy_context"].pop("strategy_name")

    errors = validate_input(payload)

    assert errors
    assert any("strategy_context.strategy_name" in err for err in errors)


def test_validate_input_missing_execution_constraints_reports_error(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload["constraints"].pop("execution_constraints")

    errors = validate_input(payload)

    assert errors
    assert any("constraints.execution_constraints" in err for err in errors)


def test_validate_input_missing_market_summary_reports_error(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload["market_context"].pop("summary")

    errors = validate_input(payload)

    assert errors
    assert any("market_context.summary" in err for err in errors)


def test_validate_input_invalid_objective_type_reports_error(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload["objective"] = "improve edge"

    errors = validate_input(payload)

    assert errors
    assert any("objective must be an object" in err for err in errors)


def test_fill_defaults_sets_optional_fields(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload.pop("performance_summary", None)
    payload.pop("trade_log_summary", None)
    payload.pop("feature_inventory", None)
    payload.pop("journal_snippets", None)
    payload.pop("qualitative_notes", None)
    payload.pop("artifacts", None)

    normalized = fill_defaults(payload)

    assert normalized["performance_summary"] is None
    assert normalized["trade_log_summary"] is None
    assert normalized["feature_inventory"] == []
    assert normalized["journal_snippets"] == []
    assert normalized["qualitative_notes"] == []
    assert normalized["artifacts"] == []


def test_fill_defaults_does_not_mutate_input(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload.pop("feature_inventory")

    copied_before = deepcopy(payload)
    _ = fill_defaults(payload)

    assert payload == copied_before


def test_normalize_returns_filled_payload_and_no_errors(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload.pop("qualitative_notes")

    normalized, errors = normalize(payload)

    assert errors == []
    assert normalized["qualitative_notes"] == []


def test_normalize_returns_errors_for_invalid_input(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload["market_context"] = "risk_on"

    normalized, errors = normalize(payload)

    assert isinstance(normalized, dict)
    assert errors
    assert any("market_context" in err for err in errors)


def test_validate_raw_hypotheses_accepts_valid_payload(raw_hypotheses_payload: dict) -> None:
    errors = validate_raw_hypotheses(raw_hypotheses_payload)
    assert errors == []


def test_validate_raw_hypotheses_requires_hypotheses_key(raw_hypotheses_payload: dict) -> None:
    payload = deepcopy(raw_hypotheses_payload)
    payload.pop("hypotheses")

    errors = validate_raw_hypotheses(payload)

    assert errors
    assert any("hypotheses" in err for err in errors)


def test_validate_raw_hypotheses_rejects_empty_array(raw_hypotheses_payload: dict) -> None:
    payload = deepcopy(raw_hypotheses_payload)
    payload["hypotheses"] = []

    errors = validate_raw_hypotheses(payload)

    assert errors
    assert any("1-5" in err for err in errors)


def test_validate_raw_hypotheses_rejects_more_than_five(raw_hypotheses_payload: dict) -> None:
    payload = deepcopy(raw_hypotheses_payload)
    payload["hypotheses"] = payload["hypotheses"] * 6

    errors = validate_raw_hypotheses(payload)

    assert errors
    assert any("1-5" in err for err in errors)


def test_validate_raw_hypotheses_requires_hypothesis_id(raw_hypotheses_payload: dict) -> None:
    payload = deepcopy(raw_hypotheses_payload)
    payload["hypotheses"][0].pop("hypothesis_id")

    errors = validate_raw_hypotheses(payload)

    assert errors
    assert any("hypothesis_id" in err for err in errors)


def test_validate_raw_hypotheses_recommendation_enum(raw_hypotheses_payload: dict) -> None:
    payload = deepcopy(raw_hypotheses_payload)
    payload["hypotheses"][0]["recommendation"] = "buy"

    errors = validate_raw_hypotheses(payload)

    assert errors
    assert any("recommendation" in err for err in errors)


def test_validate_raw_hypotheses_score_component_range(raw_hypotheses_payload: dict) -> None:
    payload = deepcopy(raw_hypotheses_payload)
    payload["hypotheses"][0]["score_components"]["novelty"] = 6

    errors = validate_raw_hypotheses(payload)

    assert errors
    assert any("score_components.novelty" in err for err in errors)
