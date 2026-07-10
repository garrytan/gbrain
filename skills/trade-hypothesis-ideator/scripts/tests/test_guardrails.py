"""Cross-cutting guardrail tests for output validation."""

from __future__ import annotations

from copy import deepcopy

from pipeline.format_output import (
    check_constraint_violations,
    check_duplicate_hypotheses,
    validate_output_bundle,
)


def _bundle(card: dict) -> dict:
    return {
        "generated_at_utc": "2026-03-05T00:00:00Z",
        "summary": "guardrail summary",
        "state_assessment": "guardrail assessment",
        "hypotheses": [card],
        "selected_next_actions": ["run test"],
        "warnings": [],
    }


class TestFieldCompleteness:
    """evidence_basis, kill_criteria, MVE, and count checks."""

    def test_empty_evidence_basis_fails(self, base_hypothesis_card: dict) -> None:
        card = deepcopy(base_hypothesis_card)
        card["evidence_basis"] = []
        assert validate_output_bundle(_bundle(card))

    def test_empty_kill_criteria_fails(self, base_hypothesis_card: dict) -> None:
        card = deepcopy(base_hypothesis_card)
        card["kill_criteria"] = []
        assert validate_output_bundle(_bundle(card))

    def test_empty_mve_fails(self, base_hypothesis_card: dict) -> None:
        card = deepcopy(base_hypothesis_card)
        card["minimum_viable_experiment"] = {}
        errors = validate_output_bundle(_bundle(card))
        assert any("minimum_viable_experiment" in err for err in errors)

    def test_hypotheses_exceeds_five_fails(self, base_hypothesis_card: dict) -> None:
        bundle = _bundle(base_hypothesis_card)
        bundle["hypotheses"] = [deepcopy(base_hypothesis_card) for _ in range(6)]
        for idx, card in enumerate(bundle["hypotheses"]):
            card["hypothesis_id"] = f"H-{idx + 1:03d}"
        assert validate_output_bundle(bundle)


class TestBannedPhrases:
    """Banned phrase detection."""

    def test_banned_phrase_japanese(self, base_hypothesis_card: dict) -> None:
        card = deepcopy(base_hypothesis_card)
        card["thesis"] = "このルールは本番投入可能で確実に勝てる。"
        errors = validate_output_bundle(_bundle(card))
        assert any("本番投入可能" in err for err in errors)

    def test_banned_phrase_english(self, base_hypothesis_card: dict) -> None:
        card = deepcopy(base_hypothesis_card)
        card["mechanism"] = "This is production ready with guaranteed edge."
        errors = validate_output_bundle(_bundle(card))
        assert any("production ready" in err.lower() for err in errors)


class TestConstraintViolation:
    """Constraint violation detection via check_constraint_violations."""

    def test_data_constraint_violation(self, base_hypothesis_card: dict) -> None:
        card = deepcopy(base_hypothesis_card)
        card["proposed_rule_changes"][0]["change"] = "Use tick-level data to detect order flow."
        constraints = {"data_constraints": ["No reliance on sub-second data"]}

        issues = check_constraint_violations(card, constraints)

        assert issues
        assert any("sub-second" in issue.lower() for issue in issues)

    def test_risk_constraint_violation(self, base_hypothesis_card: dict) -> None:
        card = deepcopy(base_hypothesis_card)
        card["proposed_rule_changes"][0]["change"] = (
            "Increase to 10 positions during earnings week."
        )
        constraints = {"risk_constraints": ["Max 6 concurrent positions"]}

        issues = check_constraint_violations(card, constraints)

        assert issues
        assert any("max 6" in issue.lower() or "10" in issue for issue in issues)

    def test_no_violation_when_constraints_respected(self, base_hypothesis_card: dict) -> None:
        constraints = {
            "data_constraints": ["No reliance on sub-second data"],
            "risk_constraints": ["Max 6 concurrent positions"],
        }

        assert check_constraint_violations(base_hypothesis_card, constraints) == []


class TestDuplicateDetection:
    """Duplicate hypothesis detection checks."""

    def test_identical_hypothesis_id(self, base_hypothesis_card: dict) -> None:
        card1 = deepcopy(base_hypothesis_card)
        card2 = deepcopy(base_hypothesis_card)

        issues = check_duplicate_hypotheses([card1, card2])

        assert any("hypothesis_id" in issue for issue in issues)

    def test_similar_titles_detected(self, base_hypothesis_card: dict) -> None:
        card1 = deepcopy(base_hypothesis_card)
        card1["hypothesis_id"] = "H-001"
        card1["title"] = "VWAP hold continuation"

        card2 = deepcopy(base_hypothesis_card)
        card2["hypothesis_id"] = "H-002"
        card2["title"] = "VWAP-based continuation entry"

        issues = check_duplicate_hypotheses([card1, card2])

        assert any("title" in issue.lower() for issue in issues)

    def test_distinct_hypotheses_pass(self, base_hypothesis_card: dict) -> None:
        card1 = deepcopy(base_hypothesis_card)
        card1["hypothesis_id"] = "H-001"
        card1["title"] = "VWAP hold continuation"

        card2 = deepcopy(base_hypothesis_card)
        card2["hypothesis_id"] = "H-002"
        card2["title"] = "Pivot breakout after contraction"
        card2["problem_target"] = "False breakouts in low breadth"
        card2["mechanism"] = "Contraction + volume expansion indicates new demand."

        assert check_duplicate_hypotheses([card1, card2]) == []


class TestGoldenPath:
    def test_valid_output_passes_all_guardrails(
        self, example_output: dict, example_input: dict
    ) -> None:
        errors = validate_output_bundle(example_output, constraints=example_input["constraints"])
        assert errors == []
