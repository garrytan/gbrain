#!/usr/bin/env python3
"""Run trade-hypothesis-ideator pipeline in two-pass mode."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from pipeline.evidence_extractor import extract_evidence, format_evidence_for_prompt
from pipeline.format_output import (
    build_logging_payload,
    build_markdown_report,
    validate_output_bundle,
)
from pipeline.normalize import normalize, validate_raw_hypotheses
from pipeline.ranking import rank_hypotheses
from pipeline.strategy_exporter import can_export, export_candidate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "trade-hypothesis-ideator: pass1 (evidence summary) or pass2 "
            "(rank/format/export hypotheses)"
        )
    )
    parser.add_argument("--input", required=True, help="Path to input bundle JSON")
    parser.add_argument(
        "--hypotheses",
        default=None,
        help="Path to raw hypotheses JSON (pass2). If omitted, pass1 runs.",
    )
    parser.add_argument("--output-dir", required=True, help="Directory for generated artifacts")
    parser.add_argument(
        "--export-strategies",
        action="store_true",
        help="Export pursue hypotheses into strategy.yaml + metadata.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        input_payload = json.loads(input_path.read_text())
    except FileNotFoundError:
        _print_err(f"input file not found: {input_path}")
        return 1
    except json.JSONDecodeError as exc:
        _print_err(f"failed to parse input JSON: {exc}")
        return 1

    normalized, input_errors = normalize(input_payload)
    if input_errors:
        _print_errors("input validation failed", input_errors)
        return 1

    if not args.hypotheses:
        return _run_pass1(normalized, output_dir)

    return _run_pass2(
        normalized, Path(args.hypotheses).resolve(), output_dir, args.export_strategies
    )


def _run_pass1(normalized: dict, output_dir: Path) -> int:
    evidence = extract_evidence(normalized)
    prompt_ready = format_evidence_for_prompt(evidence)

    evidence_payload = {
        "generated_at_utc": _utc_now(),
        "objective": normalized.get("objective", {}),
        "evidence_summary": asdict(evidence),
        "prompt_ready_text": prompt_ready,
    }

    out_path = output_dir / "evidence_summary.json"
    out_path.write_text(
        json.dumps(evidence_payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )

    print(f"[OK] pass1 completed: {out_path}")
    return 0


def _run_pass2(
    normalized: dict,
    hypotheses_path: Path,
    output_dir: Path,
    export_strategies: bool,
) -> int:
    try:
        raw_payload = json.loads(hypotheses_path.read_text())
    except FileNotFoundError:
        _print_err(f"hypotheses file not found: {hypotheses_path}")
        return 1
    except json.JSONDecodeError as exc:
        _print_err(f"failed to parse hypotheses JSON: {exc}")
        return 1

    raw_errors = validate_raw_hypotheses(raw_payload)
    if raw_errors:
        _print_errors("raw hypotheses validation failed", raw_errors)
        return 1

    try:
        ranked_hypotheses = rank_hypotheses(raw_payload["hypotheses"])
    except ValueError as exc:
        _print_err(str(exc))
        return 1

    bundle = {
        "generated_at_utc": _utc_now(),
        "summary": _build_summary(ranked_hypotheses),
        "state_assessment": "Ranked hypotheses validated against guardrails.",
        "hypotheses": ranked_hypotheses,
        "selected_next_actions": _build_next_actions(ranked_hypotheses),
        "warnings": [],
    }

    output_errors = validate_output_bundle(bundle, constraints=normalized.get("constraints"))
    if output_errors:
        _print_errors("output validation failed", output_errors)
        return 1

    bundle["logging_payload"] = build_logging_payload(bundle, normalized)

    bundle_path = output_dir / "output_bundle.json"
    report_path = output_dir / "hypothesis_report.md"
    bundle_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    report_path.write_text(build_markdown_report(bundle), encoding="utf-8")

    print(f"[OK] pass2 bundle: {bundle_path}")
    print(f"[OK] pass2 report: {report_path}")

    if export_strategies:
        exported = _export_strategies(ranked_hypotheses, output_dir)
        print(f"[OK] exported strategies: {len(exported)}")

    return 0


def _export_strategies(hypotheses: list[dict], output_dir: Path) -> list[str]:
    strategies_dir = output_dir / "strategies"
    exported_ids: list[str] = []

    for card in hypotheses:
        if not can_export(card):
            continue
        candidate_dir = export_candidate(card, strategies_dir, dry_run=False)
        if candidate_dir is not None:
            exported_ids.append(candidate_dir.name)

    manifest = {
        "generated_at_utc": _utc_now(),
        "count": len(exported_ids),
        "candidate_ids": exported_ids,
    }
    manifest_path = output_dir / "strategy_exports.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )

    return exported_ids


def _build_summary(hypotheses: list[dict]) -> str:
    if not hypotheses:
        return "No hypotheses were ranked."
    top = hypotheses[0]
    return (
        "Top hypothesis: "
        f"{top.get('hypothesis_id', 'unknown')} ({top.get('title', 'untitled')}) "
        f"with priority score {top.get('priority_score', 'n/a')}."
    )


def _build_next_actions(hypotheses: list[dict]) -> list[str]:
    actions: list[str] = []
    for card in hypotheses:
        if card.get("recommendation") != "pursue":
            continue
        mve = card.get("minimum_viable_experiment")
        if isinstance(mve, dict):
            goal = str(mve.get("goal", "")).strip()
            if goal:
                actions.append(f"Run MVE: {goal}")
    if not actions:
        actions.append("Review ranked hypotheses and define one testable MVE.")
    return actions


def _print_err(message: str) -> None:
    print(f"[ERROR] {message}", file=sys.stderr)


def _print_errors(prefix: str, errors: list[str]) -> None:
    print(f"[ERROR] {prefix}", file=sys.stderr)
    for err in errors:
        print(f"  - {err}", file=sys.stderr)


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    raise SystemExit(main())
