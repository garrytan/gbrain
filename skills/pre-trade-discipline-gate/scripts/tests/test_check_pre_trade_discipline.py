"""Tests for check_pre_trade_discipline.py."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import yaml
from check_pre_trade_discipline import (
    evaluate_pre_trade_gate,
    finalize_links,
    load_candidates,
    main,
    parse_as_of,
    write_reports,
)


def load_thesis_store_module():
    module_path = (
        Path(__file__).resolve().parents[3] / "trader-memory-core" / "scripts" / "thesis_store.py"
    )
    spec = importlib.util.spec_from_file_location("thesis_store_for_pre_trade_tests", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path: Path, data: dict | list) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def write_yaml(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


def write_thesis(
    state_dir: Path,
    thesis_id: str = "th_test_gm_20260702_0001",
    *,
    ticker: str = "TEST",
    status: str = "CLOSED",
    history: list[dict] | None = None,
    outcome_pnl: float | None = None,
    exit_date: str | None = None,
    monitoring: dict | None = None,
) -> Path:
    thesis = {
        "thesis_id": thesis_id,
        "ticker": ticker,
        "created_at": "2026-07-01T09:30:00-04:00",
        "updated_at": "2026-07-02T16:00:00-04:00",
        "thesis_type": "growth_momentum",
        "status": status,
        "status_history": history or [],
        "thesis_statement": f"{ticker} test thesis",
        "origin": {"skill": "pre-trade-test", "output_file": "fixture.json"},
        "linked_reports": [],
        "monitoring": monitoring
        or {
            "last_review_date": None,
            "next_review_date": None,
            "review_status": "OK",
            "review_interval_days": 30,
            "alerts": [],
        },
        "entry": {"planned_price": 100.0, "actual_price": 100.0, "actual_date": "2026-07-01"},
        "exit": {},
        "outcome": {"pnl_dollars": outcome_pnl, "pnl_pct": None},
    }
    if exit_date:
        thesis["exit"] = {"actual_date": exit_date, "actual_price": 95.0, "exit_reason": "manual"}
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / f"{thesis_id}.yaml"
    path.write_text(yaml.safe_dump(thesis, sort_keys=False), encoding="utf-8")
    return path


def base_candidate(**overrides):
    candidate = {
        "symbol": "AAPL",
        "order_intent": "ENTRY_READY",
        "entry_in_written_plan": True,
        "stop_predefined": True,
        "size_within_plan": True,
        "planned_risk_dollars": 500,
        "actual_risk_dollars": 500,
    }
    candidate.update(overrides)
    return candidate


def allowed_artifacts(tmp_path: Path) -> tuple[Path, Path]:
    market = write_json(tmp_path / "exposure.json", {"recommendation": "NEW_ENTRY_ALLOWED"})
    circuit = write_json(tmp_path / "circuit.json", {"recommendation": "TRADING_ALLOWED"})
    return market, circuit


def evaluate(tmp_path: Path, candidates: list[dict], **kwargs) -> dict:
    market, circuit = allowed_artifacts(tmp_path)
    params = {
        "as_of": parse_as_of("2026-07-03T12:00:00-04:00"),
        "state_dir": tmp_path / "theses",
        "revenge_window_hours": 24.0,
        "market_regime_decision": market,
        "circuit_breaker_decision": circuit,
        "output_dir": tmp_path / "reports",
        "json_only": False,
    }
    params.update(kwargs)
    result = evaluate_pre_trade_gate(candidates, **params)
    finalize_links(result, state_dir=params["state_dir"], as_of=params["as_of"])
    return result


def test_go_when_all_checks_pass(tmp_path: Path):
    result = evaluate(tmp_path, [base_candidate(notes="Plan checked before open")])

    assert result["overall_decision"] == "GO"
    assert result["candidate_results"][0]["decision"] == "GO"
    assert result["candidate_results"][0]["checklist_answers"] == {
        "entry_in_written_plan": True,
        "stop_predefined": True,
        "size_within_plan": True,
        "planned_risk_dollars": 500,
        "actual_risk_dollars": 500,
        "notes": "Plan checked before open",
    }


def test_missing_written_plan_stop_and_size_block_order(tmp_path: Path):
    result = evaluate(
        tmp_path,
        [
            base_candidate(
                entry_in_written_plan=False,
                stop_predefined=False,
                size_within_plan=False,
            )
        ],
    )

    assert result["overall_decision"] == "NO_GO"
    reasons = result["candidate_results"][0]["reasons"]
    assert "entry is not confirmed in the written plan" in reasons
    assert "stop is not predefined" in reasons
    assert "size is not confirmed within plan" in reasons


def test_actual_risk_above_plan_blocks_order(tmp_path: Path):
    result = evaluate(tmp_path, [base_candidate(planned_risk_dollars=500, actual_risk_dollars=501)])

    assert result["overall_decision"] == "NO_GO"
    assert (
        "actual risk 501.00 exceeds planned risk 500.00"
        in result["candidate_results"][0]["reasons"]
    )


def test_watchlist_only_is_no_actionable_orders_even_without_external_artifacts(tmp_path: Path):
    result = evaluate_pre_trade_gate(
        [base_candidate(order_intent="DELAYED_EP_WATCH")],
        as_of=parse_as_of("2026-07-03"),
        state_dir=None,
        revenge_window_hours=24,
        market_regime_decision=None,
        circuit_breaker_decision=None,
        output_dir=tmp_path / "reports",
        json_only=False,
    )
    finalize_links(result, state_dir=None, as_of=parse_as_of("2026-07-03"))

    assert result["overall_decision"] == "NO_ACTIONABLE_ORDERS"
    assert result["candidate_results"][0]["decision"] == "NO_ACTIONABLE_ORDERS"


def test_actionable_go_plus_watchlist_stays_go(tmp_path: Path):
    result = evaluate(
        tmp_path,
        [
            base_candidate(symbol="AAPL", order_intent="ENTRY_READY"),
            base_candidate(symbol="MSFT", order_intent="WATCHLIST"),
        ],
    )

    assert result["overall_decision"] == "GO"
    assert result["candidate_results"][0]["decision"] == "GO"
    assert result["candidate_results"][1]["decision"] == "NO_ACTIONABLE_ORDERS"


def test_unknown_intent_requires_review_not_no_actionable(tmp_path: Path):
    result = evaluate_pre_trade_gate(
        [base_candidate(order_intent="MAYBE_BUY")],
        as_of=parse_as_of("2026-07-03"),
        state_dir=None,
        revenge_window_hours=24,
        market_regime_decision=None,
        circuit_breaker_decision=None,
        output_dir=tmp_path / "reports",
        json_only=False,
    )
    finalize_links(result, state_dir=None, as_of=parse_as_of("2026-07-03"))

    assert result["overall_decision"] == "REVIEW_REQUIRED"
    assert result["candidate_results"][0]["decision"] == "REVIEW_REQUIRED"
    assert "unknown; review before acting" in result["candidate_results"][0]["reasons"][0]


def test_missing_market_and_circuit_artifacts_require_review_for_actionable_order(tmp_path: Path):
    result = evaluate_pre_trade_gate(
        [base_candidate()],
        as_of=parse_as_of("2026-07-03"),
        state_dir=None,
        revenge_window_hours=24,
        market_regime_decision=None,
        circuit_breaker_decision=None,
        output_dir=tmp_path / "reports",
        json_only=False,
    )
    finalize_links(result, state_dir=None, as_of=parse_as_of("2026-07-03"))

    assert result["overall_decision"] == "REVIEW_REQUIRED"
    reasons = result["candidate_results"][0]["reasons"]
    assert "market_regime artifact not provided" in reasons
    assert "circuit_breaker artifact not provided" in reasons


def test_market_reduce_only_and_cash_priority_block_orders(tmp_path: Path):
    for recommendation in ("REDUCE_ONLY", "cash-priority"):
        market = write_json(tmp_path / f"{recommendation}.json", {"recommendation": recommendation})
        circuit = write_json(
            tmp_path / f"{recommendation}_circuit.json", {"recommendation": "TRADING_ALLOWED"}
        )
        result = evaluate(
            tmp_path,
            [base_candidate(symbol=recommendation)],
            market_regime_decision=market,
            circuit_breaker_decision=circuit,
        )
        assert result["overall_decision"] == "NO_GO"


def test_circuit_breaker_cooldown_and_halted_block_orders(tmp_path: Path):
    market = write_json(tmp_path / "market.json", {"recommendation": "NEW_ENTRY_ALLOWED"})
    for recommendation in ("COOLDOWN", "HALTED", "TRADING_HALTED"):
        circuit = write_json(
            tmp_path / f"{recommendation}.json", {"recommendation": recommendation}
        )
        result = evaluate(
            tmp_path,
            [base_candidate(symbol=recommendation)],
            market_regime_decision=market,
            circuit_breaker_decision=circuit,
        )
        assert result["overall_decision"] == "NO_GO"


def test_future_loss_events_are_ignored(tmp_path: Path):
    state_dir = tmp_path / "theses"
    write_thesis(
        state_dir,
        history=[
            {
                "status": "PARTIALLY_CLOSED",
                "at": "2026-07-03T13:00:00-04:00",
                "reason": "future trim",
                "realized_pnl": -500,
            }
        ],
    )

    result = evaluate(
        tmp_path,
        [base_candidate()],
        state_dir=state_dir,
        as_of=parse_as_of("2026-07-03T12:00:00-04:00"),
    )

    assert result["overall_decision"] == "GO"


def test_recent_partial_loss_blocks_revenge_trade(tmp_path: Path):
    state_dir = tmp_path / "theses"
    write_thesis(
        state_dir,
        history=[
            {
                "status": "PARTIALLY_CLOSED",
                "at": "2026-07-03T11:00:00-04:00",
                "reason": "loss trim",
                "realized_pnl": -250,
            }
        ],
    )

    result = evaluate(tmp_path, [base_candidate()], state_dir=state_dir)

    assert result["overall_decision"] == "NO_GO"
    assert any(
        "recent losing exit/trim within 24h" in r for r in result["candidate_results"][0]["reasons"]
    )


def test_terminal_outcome_fallback_blocks_revenge_trade(tmp_path: Path):
    state_dir = tmp_path / "theses"
    write_thesis(
        state_dir,
        outcome_pnl=-125,
        exit_date="2026-07-03",
        history=[{"status": "CLOSED", "at": "2026-07-03T00:00:00+00:00", "reason": "legacy"}],
    )

    result = evaluate(tmp_path, [base_candidate()], state_dir=state_dir)

    assert result["overall_decision"] == "NO_GO"
    assert any("outcome.pnl_dollars" in r for r in result["candidate_results"][0]["reasons"])


def test_bare_terminal_exit_date_counts_on_named_et_date_at_night(tmp_path: Path):
    state_dir = tmp_path / "theses"
    write_thesis(
        state_dir,
        thesis_id="th_bare_exit_gm_20260703_0001",
        outcome_pnl=-100,
        exit_date="2026-07-03",
        history=[{"status": "CLOSED", "at": "2026-07-03", "reason": "legacy close"}],
    )

    timestamp_as_of = evaluate(
        tmp_path,
        [base_candidate()],
        state_dir=state_dir,
        as_of=parse_as_of("2026-07-03T23:00:00-04:00"),
    )
    date_only_as_of = evaluate(
        tmp_path,
        [base_candidate(symbol="MSFT")],
        state_dir=state_dir,
        as_of=parse_as_of("2026-07-03"),
    )

    assert timestamp_as_of["overall_decision"] == "NO_GO"
    assert date_only_as_of["overall_decision"] == "NO_GO"
    assert any(
        "outcome.pnl_dollars" in r for r in timestamp_as_of["candidate_results"][0]["reasons"]
    )
    assert any(
        "outcome.pnl_dollars" in r for r in date_only_as_of["candidate_results"][0]["reasons"]
    )


def test_producer_bare_date_trim_counts_on_named_trading_date(tmp_path: Path):
    thesis_store = load_thesis_store_module()
    state_dir = tmp_path / "theses"
    thesis_id = thesis_store.register(
        state_dir,
        {
            "ticker": "PROD",
            "thesis_type": "growth_momentum",
            "thesis_statement": "Producer-backed thesis",
            "origin": {"skill": "pre-trade-test", "output_file": "fixture.json"},
            "_source_date": "2026-07-01",
        },
    )
    assert (
        thesis_store.main(
            [
                "--state-dir",
                str(state_dir),
                "transition",
                thesis_id,
                "ENTRY_READY",
                "--reason",
                "ready",
                "--event-date",
                "2026-07-01",
            ]
        )
        == 0
    )
    assert (
        thesis_store.main(
            [
                "--state-dir",
                str(state_dir),
                "open-position",
                thesis_id,
                "--actual-price",
                "100",
                "--actual-date",
                "2026-07-01",
                "--shares",
                "10",
                "--event-date",
                "2026-07-01",
            ]
        )
        == 0
    )
    assert (
        thesis_store.main(
            [
                "--state-dir",
                str(state_dir),
                "trim",
                thesis_id,
                "--shares-sold",
                "1",
                "--price",
                "90",
                "--date",
                "2026-07-03",
            ]
        )
        == 0
    )

    result = evaluate(
        tmp_path,
        [base_candidate()],
        state_dir=state_dir,
        as_of=parse_as_of("2026-07-03T12:00:00-04:00"),
    )

    assert result["overall_decision"] == "NO_GO"
    assert any("PROD -10.00" in r for r in result["candidate_results"][0]["reasons"])


def test_link_report_updates_linked_reports_not_monitoring(tmp_path: Path):
    thesis_store = load_thesis_store_module()
    state_dir = tmp_path / "theses"
    thesis_id = thesis_store.register(
        state_dir,
        {
            "ticker": "LINK",
            "thesis_type": "growth_momentum",
            "thesis_statement": "Link report test thesis",
            "origin": {"skill": "pre-trade-test", "output_file": "fixture.json"},
            "_source_date": "2026-07-02",
        },
    )
    before = yaml.safe_load((state_dir / f"{thesis_id}.yaml").read_text())

    result = evaluate(
        tmp_path,
        [base_candidate(symbol="LINK", thesis_id=thesis_id)],
        state_dir=state_dir,
    )
    write_reports(result, tmp_path / "reports", json_only=False)

    thesis = yaml.safe_load((state_dir / f"{thesis_id}.yaml").read_text())
    assert result["overall_decision"] == "GO"
    assert result["candidate_results"][0]["link_status"] == "linked"
    assert thesis["linked_reports"][0]["skill"] == "pre-trade-discipline-gate"
    assert thesis["monitoring"]["last_review_date"] == before["monitoring"]["last_review_date"]
    assert thesis["monitoring"]["next_review_date"] == before["monitoring"]["next_review_date"]
    assert thesis["monitoring"]["review_status"] == before["monitoring"]["review_status"]


def test_report_write_failure_does_not_link_thesis(tmp_path: Path):
    thesis_store = load_thesis_store_module()
    state_dir = tmp_path / "theses"
    thesis_id = thesis_store.register(
        state_dir,
        {
            "ticker": "FAILWRITE",
            "thesis_type": "growth_momentum",
            "thesis_statement": "Write failure link test thesis",
            "origin": {"skill": "pre-trade-test", "output_file": "fixture.json"},
            "_source_date": "2026-07-02",
        },
    )
    answers = write_json(
        tmp_path / "answers.json",
        {"candidates": [base_candidate(symbol="FAILWRITE", thesis_id=thesis_id)]},
    )
    market, circuit = allowed_artifacts(tmp_path)
    output_file = tmp_path / "not_a_directory"
    output_file.write_text("blocks output_dir mkdir", encoding="utf-8")

    exit_code = main(
        [
            "--answers-file",
            str(answers),
            "--state-dir",
            str(state_dir),
            "--market-regime-decision",
            str(market),
            "--circuit-breaker-decision",
            str(circuit),
            "--output-dir",
            str(output_file),
            "--journal-dir",
            str(tmp_path / "journal"),
        ]
    )

    thesis = yaml.safe_load((state_dir / f"{thesis_id}.yaml").read_text())
    assert exit_code == 1
    assert thesis["linked_reports"] == []


def test_cli_writes_json_markdown_and_journal(tmp_path: Path):
    answers = write_json(tmp_path / "answers.json", {"candidates": [base_candidate()]})
    market, circuit = allowed_artifacts(tmp_path)
    output_dir = tmp_path / "reports"
    journal_dir = tmp_path / "journal"

    exit_code = main(
        [
            "--answers-file",
            str(answers),
            "--market-regime-decision",
            str(market),
            "--circuit-breaker-decision",
            str(circuit),
            "--output-dir",
            str(output_dir),
            "--journal-dir",
            str(journal_dir),
            "--as-of",
            "2026-07-03",
        ]
    )

    assert exit_code == 0
    assert list(output_dir.glob("pre_trade_discipline_decision_*.json"))
    assert list(output_dir.glob("pre_trade_discipline_decision_*.md"))
    journal_files = list(journal_dir.glob("pre_trade_discipline_*.jsonl"))
    assert journal_files
    journal_row = json.loads(journal_files[0].read_text().splitlines()[0])
    assert journal_row["candidate_results"][0]["checklist_answers"]["entry_in_written_plan"] is True


def test_fail_on_non_go_returns_two(tmp_path: Path):
    answers = write_json(
        tmp_path / "answers.json",
        {"candidates": [base_candidate(entry_in_written_plan=False)]},
    )
    market, circuit = allowed_artifacts(tmp_path)

    exit_code = main(
        [
            "--answers-file",
            str(answers),
            "--market-regime-decision",
            str(market),
            "--circuit-breaker-decision",
            str(circuit),
            "--output-dir",
            str(tmp_path / "reports"),
            "--journal-dir",
            str(tmp_path / "journal"),
            "--fail-on-non-go",
        ]
    )

    assert exit_code == 2


def test_yaml_answers_file_is_supported(tmp_path: Path):
    answers = write_yaml(tmp_path / "answers.yaml", {"candidates": [base_candidate()]})

    assert load_candidates(answers)[0]["symbol"] == "AAPL"
