"""Tests for output formatting and guardrail validation (Step G)."""

from __future__ import annotations

from copy import deepcopy

from pipeline.format_output import (
    build_logging_payload,
    build_markdown_report,
    check_duplicate_hypotheses,
    validate_hypothesis_card,
    validate_output_bundle,
)


def _bundle_from_card(card: dict) -> dict:
    return {
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "summary": "test summary",
        "state_assessment": "test assessment",
        "hypotheses": [card],
        "selected_next_actions": ["run backtest"],
        "warnings": [],
    }


def test_validate_hypothesis_card_valid_card_passes(base_hypothesis_card: dict) -> None:
    assert validate_hypothesis_card(base_hypothesis_card) == []


def test_validate_hypothesis_card_empty_evidence_basis_fails(base_hypothesis_card: dict) -> None:
    card = deepcopy(base_hypothesis_card)
    card["evidence_basis"] = []

    errors = validate_hypothesis_card(card)

    assert errors
    assert any("evidence_basis" in err for err in errors)


def test_validate_hypothesis_card_empty_kill_criteria_fails(base_hypothesis_card: dict) -> None:
    card = deepcopy(base_hypothesis_card)
    card["kill_criteria"] = []

    errors = validate_hypothesis_card(card)

    assert errors
    assert any("kill_criteria" in err for err in errors)


def test_validate_hypothesis_card_missing_mve_goal_fails(base_hypothesis_card: dict) -> None:
    card = deepcopy(base_hypothesis_card)
    card["minimum_viable_experiment"].pop("goal")

    errors = validate_hypothesis_card(card)

    assert errors
    assert any("minimum_viable_experiment.goal" in err for err in errors)


def test_validate_output_bundle_rejects_more_than_five_hypotheses(
    base_hypothesis_card: dict,
) -> None:
    bundle = _bundle_from_card(base_hypothesis_card)
    bundle["hypotheses"] = [deepcopy(base_hypothesis_card) for _ in range(6)]
    for idx, card in enumerate(bundle["hypotheses"]):
        card["hypothesis_id"] = f"H-{idx + 1:03d}"

    errors = validate_output_bundle(bundle)

    assert errors
    assert any("1-5" in err for err in errors)


def test_banned_phrase_detection_japanese(base_hypothesis_card: dict) -> None:
    card = deepcopy(base_hypothesis_card)
    card["thesis"] = "この手法は確実に勝てる。"

    errors = validate_hypothesis_card(card)

    assert errors
    assert any("確実に勝てる" in err for err in errors)


def test_banned_phrase_detection_english(base_hypothesis_card: dict) -> None:
    card = deepcopy(base_hypothesis_card)
    card["mechanism"] = "This setup is production ready in all regimes."

    errors = validate_hypothesis_card(card)

    assert errors
    assert any("production ready" in err.lower() for err in errors)


def test_duplicate_hypothesis_id_is_detected(base_hypothesis_card: dict) -> None:
    card1 = deepcopy(base_hypothesis_card)
    card2 = deepcopy(base_hypothesis_card)

    issues = check_duplicate_hypotheses([card1, card2])

    assert issues
    assert any("hypothesis_id" in issue for issue in issues)


def test_similar_titles_over_threshold_are_reported(base_hypothesis_card: dict) -> None:
    card1 = deepcopy(base_hypothesis_card)
    card1["hypothesis_id"] = "H-001"
    card1["title"] = "VWAP hold continuation"

    card2 = deepcopy(base_hypothesis_card)
    card2["hypothesis_id"] = "H-002"
    card2["title"] = "VWAP-based continuation entry"

    issues = check_duplicate_hypotheses([card1, card2])

    assert issues
    assert any("title" in issue.lower() for issue in issues)


def test_build_logging_payload_contains_required_fields(
    example_output: dict, example_input: dict
) -> None:
    payload = build_logging_payload(example_output, example_input)

    for key in (
        "objective",
        "sources_used",
        "hypothesis_ids",
        "selected_next_actions",
        "warnings",
    ):
        assert key in payload


def test_build_markdown_report_contains_sections(example_output: dict) -> None:
    report = build_markdown_report(example_output)

    lowered = report.lower()
    assert "## summary" in lowered
    assert "## hypotheses" in lowered
    assert "## risks" in lowered
