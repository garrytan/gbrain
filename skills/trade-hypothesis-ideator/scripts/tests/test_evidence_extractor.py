"""Tests for evidence extraction helpers (Step B)."""

from __future__ import annotations

from copy import deepcopy

from pipeline.evidence_extractor import extract_evidence, format_evidence_for_prompt


def test_extract_primary_issues_from_known_pain_points(example_input: dict) -> None:
    summary = extract_evidence(example_input)
    assert summary.primary_issues == example_input["strategy_context"]["known_pain_points"]


def test_extract_regime_characteristics_from_tags_and_observations(example_input: dict) -> None:
    summary = extract_evidence(example_input)

    expected = (
        example_input["market_context"]["regime_tags"]
        + example_input["market_context"]["observations"]
    )
    assert summary.regime_characteristics == expected


def test_extract_winner_and_loser_traits_separately(example_input: dict) -> None:
    summary = extract_evidence(example_input)

    assert summary.winning_patterns == example_input["trade_log_summary"]["common_winner_traits"]
    assert summary.losing_patterns == example_input["trade_log_summary"]["common_loser_traits"]


def test_extract_rejected_directions_from_non_promising_journal_items(example_input: dict) -> None:
    summary = extract_evidence(example_input)

    assert len(summary.rejected_directions) == 2
    assert any("mixed" in item for item in summary.rejected_directions)
    assert any("rejected" in item for item in summary.rejected_directions)


def test_extract_available_features_preserves_input_order(example_input: dict) -> None:
    summary = extract_evidence(example_input)
    assert summary.available_features == example_input["feature_inventory"]


def test_extract_evidence_handles_missing_optional_fields(example_input: dict) -> None:
    payload = deepcopy(example_input)
    payload["strategy_context"].pop("known_pain_points", None)
    payload["market_context"].pop("regime_tags", None)
    payload["market_context"].pop("observations", None)
    payload["trade_log_summary"] = None
    payload["feature_inventory"] = []
    payload["journal_snippets"] = []

    summary = extract_evidence(payload)

    assert summary.primary_issues == []
    assert summary.regime_characteristics == []
    assert summary.winning_patterns == []
    assert summary.losing_patterns == []
    assert summary.available_features == []
    assert summary.rejected_directions == []


def test_format_evidence_for_prompt_contains_named_sections(example_input: dict) -> None:
    summary = extract_evidence(example_input)
    text = format_evidence_for_prompt(summary)

    assert "Primary issues" in text
    assert "Regime characteristics" in text
    assert "Winning patterns" in text
    assert "Losing patterns" in text
    assert "Execution constraints" in text
