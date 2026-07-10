"""Tests for Step H strategy export integration."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import yaml
from pipeline.strategy_exporter import (
    build_metadata_json,
    build_strategy_yaml,
    can_export,
    export_candidate,
    infer_entry_family,
    validate_strategy_yaml,
)


def _hypothesis(base_hypothesis_card: dict, **overrides: object) -> dict:
    card = deepcopy(base_hypothesis_card)
    card.update(overrides)
    return card


class TestInferEntryFamily:
    def test_gap_keywords_match(self, base_hypothesis_card: dict) -> None:
        card = _hypothesis(
            base_hypothesis_card,
            thesis="Earnings gap-up with VWAP hold continuation is likely to trend.",
            proposed_rule_changes=[
                {"component": "entry_logic", "change": "Trade gap-up continuation after VWAP hold."}
            ],
        )
        assert infer_entry_family(card) == "gap_up_continuation"

    def test_breakout_keywords_match(self, base_hypothesis_card: dict) -> None:
        card = _hypothesis(
            base_hypothesis_card,
            thesis="VCP breakout after contraction increases odds of follow-through.",
            proposed_rule_changes=[
                {
                    "component": "entry_logic",
                    "change": "Require breakout above pivot after VCP pattern.",
                }
            ],
        )
        assert infer_entry_family(card) == "pivot_breakout"

    def test_no_match_returns_none(self, base_hypothesis_card: dict) -> None:
        card = _hypothesis(
            base_hypothesis_card,
            title="Intraday mean reversion filter",
            thesis="Mean reversion to prior close after panic selloff.",
            proposed_rule_changes=[
                {"component": "entry_logic", "change": "Enter after two-sigma deviation fade."}
            ],
        )
        assert infer_entry_family(card) is None


class TestCanExport:
    def test_pursue_with_valid_family(self, base_hypothesis_card: dict) -> None:
        assert can_export(base_hypothesis_card)

    def test_park_returns_false(self, base_hypothesis_card: dict) -> None:
        card = _hypothesis(base_hypothesis_card, recommendation="park")
        assert not can_export(card)

    def test_pursue_no_family_returns_false(self, base_hypothesis_card: dict) -> None:
        card = _hypothesis(
            base_hypothesis_card,
            title="Intraday mean reversion filter",
            thesis="Mean reversion in oversold names.",
            proposed_rule_changes=[
                {
                    "component": "entry_logic",
                    "change": "Fade extreme dislocations after opening spike.",
                }
            ],
        )
        assert not can_export(card)


class TestBuildStrategyYaml:
    def test_has_all_required_top_level_keys(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        required = {
            "id",
            "name",
            "universe",
            "signals",
            "risk",
            "cost_model",
            "validation",
            "promotion_gates",
        }
        assert required.issubset(spec.keys())

    def test_signals_exit_has_stop_loss(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        assert isinstance(spec["signals"]["exit"]["stop_loss"], str)
        assert spec["signals"]["exit"]["stop_loss"].strip()

    def test_signals_exit_has_trailing_or_take_profit(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        exit_rules = spec["signals"]["exit"]
        assert bool(exit_rules.get("trailing_stop") or exit_rules.get("take_profit"))

    def test_stop_loss_pct_in_range(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        assert 0 < spec["signals"]["exit"]["stop_loss_pct"] <= 0.30

    def test_risk_per_trade_in_range(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        assert 0 < spec["risk"]["risk_per_trade"] <= 0.10

    def test_validation_method_full_sample(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        assert spec["validation"]["method"] == "full_sample"
        assert spec["validation"].get("oos_ratio") is None

    def test_gap_up_includes_detection_block(self, base_hypothesis_card: dict) -> None:
        card = _hypothesis(
            base_hypothesis_card,
            thesis="Gap-up continuation after earnings with VWAP hold",
            proposed_rule_changes=[
                {"component": "entry_logic", "change": "Require gap-up and VWAP hold."}
            ],
        )
        spec = build_strategy_yaml(card, "edge_h001")
        assert "gap_up_detection" in spec

    def test_pivot_breakout_includes_detection_block(self, base_hypothesis_card: dict) -> None:
        card = _hypothesis(
            base_hypothesis_card,
            thesis="VCP breakout with volume expansion",
            proposed_rule_changes=[
                {"component": "entry_logic", "change": "Require VCP + breakout above pivot."}
            ],
        )
        spec = build_strategy_yaml(card, "edge_h001")
        assert "vcp_detection" in spec

    def test_entry_conditions_non_empty(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        assert spec["signals"]["entry"]["conditions"]


class TestValidateStrategyYaml:
    def test_valid_spec_no_errors(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        assert validate_strategy_yaml(spec, "edge_h001") == []

    def test_missing_detection_block_error(self, base_hypothesis_card: dict) -> None:
        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        spec.pop("gap_up_detection", None)

        errors = validate_strategy_yaml(spec, "edge_h001")

        assert errors
        assert any("gap_up_detection" in err for err in errors)

    def test_candidate_contract_import_failure(
        self, base_hypothesis_card: dict, monkeypatch
    ) -> None:
        from pipeline import strategy_exporter

        spec = build_strategy_yaml(base_hypothesis_card, "edge_h001")
        monkeypatch.setattr(
            strategy_exporter,
            "CANDIDATE_CONTRACT_PATH",
            Path("/tmp/does-not-exist/candidate_contract.py"),
        )

        try:
            validate_strategy_yaml(spec, "edge_h001")
        except RuntimeError as exc:
            assert "candidate_contract.py" in str(exc)
        else:
            raise AssertionError("RuntimeError was not raised")


class TestExportCandidate:
    def test_dry_run_no_files(self, base_hypothesis_card: dict, tmp_path: Path) -> None:
        out = export_candidate(base_hypothesis_card, tmp_path, dry_run=True)
        assert out is None
        assert list(tmp_path.glob("*")) == []

    def test_writes_strategy_and_metadata(self, base_hypothesis_card: dict, tmp_path: Path) -> None:
        out = export_candidate(base_hypothesis_card, tmp_path, dry_run=False)
        assert out is not None
        strategy_path = out / "strategy.yaml"
        metadata_path = out / "metadata.json"

        assert strategy_path.exists()
        assert metadata_path.exists()

        spec = yaml.safe_load(strategy_path.read_text())
        metadata = json.loads(metadata_path.read_text())

        assert spec["id"] == metadata["candidate_id"]
        assert metadata["interface_version"] == "edge-finder-candidate/v1"

    def test_build_metadata_json_contains_provenance(self, base_hypothesis_card: dict) -> None:
        metadata = build_metadata_json(base_hypothesis_card, "edge_h001")
        assert metadata["interface_version"] == "edge-finder-candidate/v1"
        assert metadata["candidate_id"] == "edge_h001"
        assert "research_context" in metadata
