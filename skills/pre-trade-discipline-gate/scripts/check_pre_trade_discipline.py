#!/usr/bin/env python3
"""
Pre-Trade Discipline Gate - manual execution checklist before placing orders.

Reads a local checklist plus optional market-regime, circuit-breaker, and
trader-memory-core state artifacts. Emits a GO / REVIEW_REQUIRED / NO_GO /
NO_ACTIONABLE_ORDERS decision for manual entries without any external API.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

ET = ZoneInfo("America/New_York")
DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PRODUCER_UTC_MIDNIGHT_RE = re.compile(
    r"^(?P<day>\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|\+00:00)$"
)

ACTIONABLE_INTENTS = {"ENTRY_READY", "ACTIONABLE", "ACTIONABLE_DAY1", "MANUAL_ORDER"}
NON_ACTIONABLE_INTENTS = {"WATCHLIST", "DELAYED_EP_WATCH", "PEAD_HANDOFF", "IGNORE", "REJECTED"}
TERMINAL_STATUSES = {"CLOSED", "INVALIDATED"}
CHECKLIST_ANSWER_FIELDS = (
    "entry_in_written_plan",
    "stop_predefined",
    "size_within_plan",
    "planned_risk_dollars",
    "actual_risk_dollars",
    "notes",
)
DECISION_RANK = {
    "GO": 0,
    "NO_ACTIONABLE_ORDERS": 1,
    "REVIEW_REQUIRED": 2,
    "NO_GO": 3,
}


@dataclass(frozen=True)
class LossEvent:
    thesis_id: str
    ticker: str
    pnl: float
    at: datetime
    source: str


@dataclass
class CandidateResult:
    symbol: str
    thesis_id: str | None
    order_intent: str
    actionable: bool
    decision: str
    reasons: list[str] = field(default_factory=list)
    checklist_answers: dict[str, Any] = field(default_factory=dict)
    link_status: str = "not_requested"


def _parse_datetime(
    value: Any,
    *,
    default_tz: ZoneInfo | timezone = timezone.utc,
) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, time.min)
    elif isinstance(value, str) and value.strip():
        normalized = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            parsed = datetime.combine(date.fromisoformat(normalized), time.min)
    else:
        raise ValueError("expected non-empty datetime string")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=default_tz)
    return parsed


def _parse_event_datetime(value: Any) -> datetime:
    """Parse trader-memory-core producer timestamps into ET accounting time."""
    if isinstance(value, str):
        stripped = value.strip()
        if DATE_ONLY_RE.match(stripped):
            return datetime.combine(date.fromisoformat(stripped), time.min, tzinfo=ET)
        match = PRODUCER_UTC_MIDNIGHT_RE.match(stripped)
        if match:
            return datetime.combine(date.fromisoformat(match.group("day")), time.min, tzinfo=ET)
    return _parse_datetime(value).astimezone(ET)


def parse_as_of(value: str | None) -> datetime:
    if not value:
        return datetime.now(ET)
    stripped = value.strip()
    if DATE_ONLY_RE.match(stripped):
        return datetime.combine(date.fromisoformat(stripped), time.max, tzinfo=ET)
    return _parse_datetime(value, default_tz=ET).astimezone(ET)


def _load_structured_file(path: Path) -> Any:
    with path.open() as f:
        if path.suffix.lower() in {".yaml", ".yml"}:
            return yaml.safe_load(f)
        return json.load(f)


def _normalize_token(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", str(value or "").strip().upper()).strip("_")


def load_candidates(answers_file: Path) -> list[dict[str, Any]]:
    data = _load_structured_file(answers_file)
    if isinstance(data, dict):
        candidates = data.get("candidates")
        if candidates is None:
            candidates = data.get("answers")
    else:
        candidates = data
    if not isinstance(candidates, list):
        raise ValueError("--answers-file must contain a candidate list or a 'candidates' list")
    normalized: list[dict[str, Any]] = []
    for idx, candidate in enumerate(candidates, start=1):
        if not isinstance(candidate, dict):
            raise ValueError(f"candidate #{idx} must be an object")
        if not candidate.get("symbol"):
            raise ValueError(f"candidate #{idx} missing symbol")
        normalized.append(candidate)
    return normalized


def _is_true(value: Any) -> bool:
    return value is True


def _to_float_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _load_thesis_file(path: Path) -> dict[str, Any]:
    with path.open() as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError("thesis file must contain a YAML object")
    return data


def load_theses(state_dir: Path | None) -> tuple[list[dict[str, Any]], list[str]]:
    if state_dir is None or not state_dir.exists():
        return [], []
    theses: list[dict[str, Any]] = []
    warnings: list[str] = []
    for path in sorted(state_dir.glob("th_*.yaml")):
        try:
            thesis = _load_thesis_file(path)
            thesis.setdefault("_source_path", str(path))
            theses.append(thesis)
        except Exception as exc:  # noqa: BLE001 - local journal state may be partial.
            warnings.append(f"Skipped {path}: {exc}")
    return theses, warnings


def _terminal_event_datetime(thesis: dict[str, Any]) -> datetime | None:
    exit_data = thesis.get("exit") or {}
    exit_date = exit_data.get("actual_date") if isinstance(exit_data, dict) else None
    if exit_date:
        try:
            return _parse_event_datetime(exit_date)
        except Exception:
            return None
    history = thesis.get("status_history", [])
    if not isinstance(history, list):
        return None
    for event in reversed(history):
        if isinstance(event, dict) and event.get("status") in TERMINAL_STATUSES and event.get("at"):
            try:
                return _parse_event_datetime(event["at"])
            except Exception:
                return None
    return None


def collect_loss_events(
    theses: list[dict[str, Any]],
    *,
    as_of: datetime,
) -> tuple[list[LossEvent], list[str]]:
    losses: list[LossEvent] = []
    warnings: list[str] = []
    for thesis in theses:
        thesis_id = str(thesis.get("thesis_id") or thesis.get("id") or "<unknown>")
        ticker = str(thesis.get("ticker") or thesis.get("symbol") or "<unknown>")
        history = thesis.get("status_history", [])
        ledger_events = 0
        if not isinstance(history, list):
            warnings.append(f"Skipped status_history for {thesis_id}: expected list")
            history = []

        for event in history:
            if not isinstance(event, dict) or "realized_pnl" not in event:
                continue
            ledger_events += 1
            try:
                pnl = float(event["realized_pnl"])
                at = _parse_event_datetime(event.get("at"))
            except Exception as exc:  # noqa: BLE001 - keep other thesis entries usable.
                warnings.append(f"Skipped realized_pnl event for {thesis_id}: {exc}")
                continue
            if pnl < 0 and at <= as_of:
                losses.append(LossEvent(thesis_id, ticker, pnl, at, "status_history.realized_pnl"))

        if thesis.get("status") not in TERMINAL_STATUSES or ledger_events:
            continue
        outcome = thesis.get("outcome") or {}
        outcome_pnl = outcome.get("pnl_dollars") if isinstance(outcome, dict) else None
        try:
            pnl = float(outcome_pnl)
        except (TypeError, ValueError):
            continue
        if pnl >= 0:
            continue
        at = _terminal_event_datetime(thesis)
        if at is None:
            warnings.append(f"Could not infer terminal loss date for {thesis_id}")
            continue
        if at <= as_of:
            losses.append(LossEvent(thesis_id, ticker, pnl, at, "outcome.pnl_dollars"))
    return sorted(losses, key=lambda item: item.at, reverse=True), warnings


def recent_losses(
    theses: list[dict[str, Any]],
    *,
    as_of: datetime,
    window_hours: float,
) -> tuple[list[LossEvent], list[str]]:
    losses, warnings = collect_loss_events(theses, as_of=as_of)
    cutoff = as_of - timedelta(hours=window_hours)
    return [loss for loss in losses if cutoff <= loss.at <= as_of], warnings


def _artifact_decision(path: Path | None, *, artifact_name: str) -> tuple[str | None, list[str]]:
    if path is None:
        return None, [f"{artifact_name} artifact not provided"]
    if not path.exists():
        return None, [f"{artifact_name} artifact not found: {path}"]
    try:
        data = _load_structured_file(path)
    except Exception as exc:  # noqa: BLE001 - converted into REVIEW_REQUIRED.
        return None, [f"{artifact_name} artifact could not be read: {exc}"]
    if not isinstance(data, dict):
        return None, [f"{artifact_name} artifact must be an object"]
    for key in ("recommendation", "decision", "status"):
        if data.get(key) is not None:
            return _normalize_token(data[key]), []
    return None, [f"{artifact_name} artifact has no recommendation field"]


def evaluate_market_regime(path: Path | None) -> tuple[str, list[str]]:
    decision, warnings = _artifact_decision(path, artifact_name="market_regime")
    if decision == "NEW_ENTRY_ALLOWED":
        return "OK", []
    if decision in {"REDUCE_ONLY", "CASH_PRIORITY"}:
        return "NO_GO", [f"market_regime recommendation is {decision}"]
    if decision is not None:
        return "REVIEW_REQUIRED", [f"market_regime recommendation is unknown: {decision}"]
    return "REVIEW_REQUIRED", warnings


def evaluate_circuit_breaker(path: Path | None) -> tuple[str, list[str]]:
    decision, warnings = _artifact_decision(path, artifact_name="circuit_breaker")
    if decision == "TRADING_ALLOWED":
        return "OK", []
    if decision in {"COOLDOWN", "HALTED", "TRADING_HALTED"}:
        return "NO_GO", [f"circuit_breaker recommendation is {decision}"]
    if decision is not None:
        return "REVIEW_REQUIRED", [f"circuit_breaker recommendation is unknown: {decision}"]
    return "REVIEW_REQUIRED", warnings


def _candidate_base_result(candidate: dict[str, Any]) -> CandidateResult:
    symbol = str(candidate["symbol"]).upper().strip()
    thesis_id = candidate.get("thesis_id")
    thesis_id = str(thesis_id) if thesis_id else None
    intent = _normalize_token(candidate.get("order_intent") or candidate.get("intent") or "")
    checklist_answers = {key: candidate.get(key) for key in CHECKLIST_ANSWER_FIELDS}
    actionable = intent in ACTIONABLE_INTENTS
    if not actionable:
        if intent in NON_ACTIONABLE_INTENTS:
            reason = f"order_intent {intent} has no manual order to place"
            decision = "NO_ACTIONABLE_ORDERS"
        else:
            reason = f"order_intent {intent or '<missing>'} is unknown; review before acting"
            decision = "REVIEW_REQUIRED"
        return CandidateResult(
            symbol,
            thesis_id,
            intent or "UNKNOWN",
            False,
            decision,
            [reason],
            checklist_answers,
        )
    return CandidateResult(symbol, thesis_id, intent, True, "GO", [], checklist_answers)


def _raise_candidate_decision(candidate: CandidateResult, decision: str, reason: str) -> None:
    if DECISION_RANK[decision] > DECISION_RANK[candidate.decision]:
        candidate.decision = decision
    candidate.reasons.append(reason)


def _evaluate_candidate_checklist(candidate: dict[str, Any], result: CandidateResult) -> None:
    if not result.actionable:
        return
    if not _is_true(candidate.get("entry_in_written_plan")):
        _raise_candidate_decision(result, "NO_GO", "entry is not confirmed in the written plan")
    if not _is_true(candidate.get("stop_predefined")):
        _raise_candidate_decision(result, "NO_GO", "stop is not predefined")
    if not _is_true(candidate.get("size_within_plan")):
        _raise_candidate_decision(result, "NO_GO", "size is not confirmed within plan")

    planned_risk = _to_float_or_none(candidate.get("planned_risk_dollars"))
    actual_risk = _to_float_or_none(candidate.get("actual_risk_dollars"))
    if planned_risk is not None and actual_risk is not None and actual_risk > planned_risk:
        _raise_candidate_decision(
            result,
            "NO_GO",
            f"actual risk {actual_risk:.2f} exceeds planned risk {planned_risk:.2f}",
        )


def aggregate_decision(candidates: list[CandidateResult]) -> str:
    if not candidates:
        return "NO_ACTIONABLE_ORDERS"
    decision = "GO"
    actionable_seen = any(candidate.actionable for candidate in candidates)
    if actionable_seen:
        for candidate in candidates:
            if not candidate.actionable and candidate.decision == "NO_ACTIONABLE_ORDERS":
                continue
            if DECISION_RANK[candidate.decision] > DECISION_RANK[decision]:
                decision = candidate.decision
        return decision

    for candidate in candidates:
        if DECISION_RANK[candidate.decision] > DECISION_RANK[decision]:
            decision = candidate.decision
    if DECISION_RANK[decision] > DECISION_RANK["NO_ACTIONABLE_ORDERS"]:
        return decision
    return "NO_ACTIONABLE_ORDERS"


def _recent_loss_reasons(losses: list[LossEvent], window_hours: float) -> list[str]:
    reasons: list[str] = []
    for loss in losses[:5]:
        reasons.append(
            "recent losing exit/trim within "
            f"{window_hours:g}h: {loss.ticker} {loss.pnl:.2f} at {loss.at.isoformat()} "
            f"({loss.source})"
        )
    return reasons


def _planned_artifact_paths(
    result: dict[str, Any], output_dir: Path, json_only: bool
) -> tuple[Path, Path | None]:
    generated_at = _parse_datetime(result["generated_at"]).astimezone(timezone.utc)
    timestamp = generated_at.strftime("%Y-%m-%d_%H%M%S")
    json_path = output_dir / f"pre_trade_discipline_decision_{timestamp}.json"
    md_path = None if json_only else output_dir / f"pre_trade_discipline_decision_{timestamp}.md"
    return json_path, md_path


def _load_thesis_store_module():
    module_path = (
        Path(__file__).resolve().parents[2] / "trader-memory-core" / "scripts" / "thesis_store.py"
    )
    spec = importlib.util.spec_from_file_location("thesis_store_for_pre_trade_gate", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load trader-memory-core module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def link_reports(
    candidates: list[CandidateResult],
    *,
    state_dir: Path | None,
    report_path: Path,
    as_of: datetime,
) -> list[str]:
    warnings: list[str] = []
    linkable = [candidate for candidate in candidates if candidate.thesis_id]
    if not linkable:
        return warnings
    if state_dir is None:
        for candidate in linkable:
            candidate.link_status = "skipped_no_state_dir"
        return warnings

    try:
        thesis_store = _load_thesis_store_module()
    except Exception as exc:  # noqa: BLE001 - actionable candidates become review-required.
        warning = f"Could not load trader-memory-core link_report: {exc}"
        warnings.append(warning)
        for candidate in linkable:
            candidate.link_status = "failed"
            if candidate.actionable:
                _raise_candidate_decision(candidate, "REVIEW_REQUIRED", warning)
        return warnings

    report_file = str(report_path)
    report_date = as_of.date().isoformat()
    for candidate in linkable:
        try:
            thesis_store.link_report(
                state_dir,
                candidate.thesis_id,
                "pre-trade-discipline-gate",
                report_file,
                report_date,
            )
            candidate.link_status = "linked"
        except Exception as exc:  # noqa: BLE001 - link failure is a journaling quality issue.
            warning = f"Could not link report for {candidate.thesis_id}: {exc}"
            warnings.append(warning)
            candidate.link_status = "failed"
            if candidate.actionable:
                _raise_candidate_decision(candidate, "REVIEW_REQUIRED", warning)
    return warnings


def evaluate_pre_trade_gate(
    candidates: list[dict[str, Any]],
    *,
    as_of: datetime,
    state_dir: Path | None,
    revenge_window_hours: float,
    market_regime_decision: Path | None,
    circuit_breaker_decision: Path | None,
    output_dir: Path,
    json_only: bool,
) -> dict[str, Any]:
    candidate_results = [_candidate_base_result(candidate) for candidate in candidates]
    for candidate, result in zip(candidates, candidate_results):
        _evaluate_candidate_checklist(candidate, result)

    warnings: list[str] = []
    theses, thesis_warnings = load_theses(state_dir)
    warnings.extend(thesis_warnings)

    actionable_candidates = [candidate for candidate in candidate_results if candidate.actionable]
    if actionable_candidates:
        market_status, market_reasons = evaluate_market_regime(market_regime_decision)
        circuit_status, circuit_reasons = evaluate_circuit_breaker(circuit_breaker_decision)
        losses, loss_warnings = recent_losses(
            theses,
            as_of=as_of,
            window_hours=revenge_window_hours,
        )
        warnings.extend(loss_warnings)

        external_rules: list[tuple[str, str]] = []
        for reason in market_reasons:
            external_rules.append((market_status, reason))
        for reason in circuit_reasons:
            external_rules.append((circuit_status, reason))
        for reason in _recent_loss_reasons(losses, revenge_window_hours):
            external_rules.append(("NO_GO", reason))

        for candidate in actionable_candidates:
            for decision, reason in external_rules:
                if decision != "OK":
                    _raise_candidate_decision(candidate, decision, reason)

    result = {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "as_of": as_of.isoformat(),
        "overall_decision": aggregate_decision(candidate_results),
        "candidate_results": [asdict(candidate) for candidate in candidate_results],
        "metrics": {
            "candidates_total": len(candidate_results),
            "actionable_candidates": len(actionable_candidates),
            "theses_scanned": len(theses),
            "revenge_window_hours": revenge_window_hours,
        },
        "inputs": {
            "state_dir": str(state_dir) if state_dir else None,
            "market_regime_decision": str(market_regime_decision)
            if market_regime_decision
            else None,
            "circuit_breaker_decision": str(circuit_breaker_decision)
            if circuit_breaker_decision
            else None,
        },
        "artifact_paths": {},
        "warnings": warnings,
        "rationale": "",
    }
    json_path, md_path = _planned_artifact_paths(result, output_dir, json_only)
    result["artifact_paths"] = {
        "json": str(json_path),
        "markdown": str(md_path) if md_path is not None else None,
    }
    return result


def finalize_links(
    result: dict[str, Any],
    *,
    state_dir: Path | None,
    as_of: datetime,
) -> None:
    candidates = [CandidateResult(**candidate) for candidate in result["candidate_results"]]
    report_path = Path(result["artifact_paths"]["json"])
    warnings = link_reports(candidates, state_dir=state_dir, report_path=report_path, as_of=as_of)
    result["candidate_results"] = [asdict(candidate) for candidate in candidates]
    result["overall_decision"] = aggregate_decision(candidates)
    result["warnings"].extend(warnings)
    result["rationale"] = build_rationale(result)


def build_rationale(result: dict[str, Any]) -> str:
    decision = result["overall_decision"]
    if decision == "GO":
        return "All actionable manual-order candidates passed the pre-trade discipline gate."
    if decision == "NO_ACTIONABLE_ORDERS":
        return "No actionable manual orders were present; nothing should be placed at the broker."
    if decision == "REVIEW_REQUIRED":
        return "At least one actionable candidate needs human review before any manual order is placed."
    return "At least one actionable candidate violated a discipline rule; do not place the manual order."


def generate_markdown_report(result: dict[str, Any]) -> str:
    lines = [
        "# Pre-Trade Discipline Decision",
        f"**As of:** {result['as_of']}",
        f"**Decision:** {result['overall_decision']}",
        "",
        "## Rationale",
        "",
        result["rationale"],
        "",
        "## Candidates",
        "",
        "| Symbol | Intent | Actionable | Decision | Reasons | Link |",
        "|--------|--------|------------|----------|---------|------|",
    ]
    for candidate in result["candidate_results"]:
        reasons = "<br>".join(candidate["reasons"]) if candidate["reasons"] else "None"
        lines.append(
            "| {symbol} | {intent} | {actionable} | {decision} | {reasons} | {link} |".format(
                symbol=candidate["symbol"],
                intent=candidate["order_intent"],
                actionable="yes" if candidate["actionable"] else "no",
                decision=candidate["decision"],
                reasons=reasons,
                link=candidate["link_status"],
            )
        )
    lines.append("")

    if result["warnings"]:
        lines.extend(["## Warnings", ""])
        lines.extend(f"- {warning}" for warning in result["warnings"])
        lines.append("")

    return "\n".join(lines)


def write_reports(
    result: dict[str, Any], output_dir: Path, json_only: bool
) -> tuple[Path, Path | None]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = Path(result["artifact_paths"]["json"])
    md_path = (
        Path(result["artifact_paths"]["markdown"]) if result["artifact_paths"]["markdown"] else None
    )
    json_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if not json_only and md_path is not None:
        md_path.write_text(generate_markdown_report(result), encoding="utf-8")
    return json_path, md_path


def write_journal(result: dict[str, Any], journal_dir: Path | None) -> Path | None:
    if journal_dir is None:
        return None
    journal_dir.mkdir(parents=True, exist_ok=True)
    generated_at = _parse_datetime(result["generated_at"]).astimezone(timezone.utc)
    journal_path = journal_dir / f"pre_trade_discipline_{generated_at.strftime('%Y-%m-%d')}.jsonl"
    result["artifact_paths"]["journal"] = str(journal_path)
    with journal_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(result, sort_keys=True) + "\n")
    return journal_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Evaluate the manual pre-trade discipline gate")
    parser.add_argument("--answers-file", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument(
        "--as-of", help="Evaluation date/time; date-only values cover the full ET day"
    )
    parser.add_argument("--revenge-window-hours", type=float, default=24.0)
    parser.add_argument("--market-regime-decision", type=Path)
    parser.add_argument("--circuit-breaker-decision", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("reports/pre-trade-discipline"))
    parser.add_argument(
        "--journal-dir", type=Path, default=Path("state/journal/pre-trade-discipline")
    )
    parser.add_argument("--json-only", action="store_true")
    parser.add_argument(
        "--fail-on-non-go",
        action="store_true",
        help="Return exit 2 when the decision is not GO.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.revenge_window_hours <= 0:
        parser.error("--revenge-window-hours must be positive")

    try:
        as_of = parse_as_of(args.as_of)
        candidates = load_candidates(args.answers_file)
        result = evaluate_pre_trade_gate(
            candidates,
            as_of=as_of,
            state_dir=args.state_dir,
            revenge_window_hours=args.revenge_window_hours,
            market_regime_decision=args.market_regime_decision,
            circuit_breaker_decision=args.circuit_breaker_decision,
            output_dir=args.output_dir,
            json_only=args.json_only,
        )
        result["rationale"] = build_rationale(result)
        json_path, md_path = write_reports(result, args.output_dir, args.json_only)
        finalize_links(result, state_dir=args.state_dir, as_of=as_of)
        journal_path = write_journal(result, args.journal_dir)
        json_path, md_path = write_reports(result, args.output_dir, args.json_only)
    except Exception as exc:  # noqa: BLE001 - CLI should return a clear message.
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"JSON report: {json_path}")
    if md_path is not None:
        print(f"Markdown report: {md_path}")
    if journal_path is not None:
        print(f"Journal: {journal_path}")
    print(f"\nDecision: {result['overall_decision']}")
    print(result["rationale"])
    if args.fail_on_non_go and result["overall_decision"] != "GO":
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
