"""Step H: export pursue hypotheses into edge-finder candidate artifacts."""

from __future__ import annotations

import importlib.util
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

INTERFACE_VERSION = "edge-finder-candidate/v1"

EXPORTABLE_ENTRY_TYPES = {"pivot_breakout", "gap_up_continuation"}

ENTRY_FAMILY_KEYWORDS = {
    "pivot_breakout": ["breakout", "pivot", "vcp", "contraction", "volatility contraction"],
    "gap_up_continuation": ["gap", "earnings gap", "continuation", "gap-up", "vwap hold"],
}

CANDIDATE_CONTRACT_PATH = (
    Path(__file__).resolve().parents[3]
    / "edge-candidate-agent"
    / "scripts"
    / "candidate_contract.py"
)

DEFAULT_UNIVERSE = {
    "type": "us_equities",
    "index": "sp500",
    "filters": ["avg_volume > 500_000", "price > 10"],
}

DEFAULT_EXIT = {
    "stop_loss": "7% below entry",
    "trailing_stop": "below 21-day EMA or 10-day low",
    "take_profit": "risk_reward_3x",
    "stop_loss_pct": 0.07,
    "take_profit_rr": 3.0,
    "breakeven_at_rr": 1.0,
}

DEFAULT_RISK = {
    "position_sizing": "fixed_risk",
    "risk_per_trade": 0.01,
    "max_positions": 5,
    "max_sector_exposure": 0.30,
}

DEFAULT_COST_MODEL = {
    "commission_per_share": 0.00,
    "slippage_bps": 5,
}

DEFAULT_PROMOTION_GATES = {
    "min_trades": 200,
    "max_drawdown": 0.15,
    "sharpe": 1.0,
    "profit_factor": 1.2,
}

DEFAULT_ENTRY_BY_FAMILY = {
    "pivot_breakout": {
        "conditions": [
            "vcp_pattern_detected",
            "breakout_above_pivot_point",
            "volume > 1.5 * avg_volume_50",
        ],
        "trend_filter": ["price > sma_200", "price > sma_50", "sma_50 > sma_200"],
    },
    "gap_up_continuation": {
        "conditions": [
            "gap_up_detected",
            "vwap_hold_in_first_30m",
            "breakout_above_gap_day_high",
        ],
        "trend_filter": ["price > sma_200", "price > sma_50", "sma_50 > sma_200"],
    },
}

DEFAULT_VCP_DETECTION = {
    "min_contractions": 2,
    "contraction_ratio": 0.75,
    "lookback_window": 120,
    "volume_decline": True,
    "breakout_volume_ratio": 1.5,
}

DEFAULT_GAP_DETECTION = {
    "min_gap_pct": 0.06,
    "volume_ratio": 2.0,
    "avg_volume_window": 50,
    "max_entry_days": 5,
    "max_stop_pct": 0.10,
}


def infer_entry_family(hypothesis: dict) -> str | None:
    """Infer exportable entry family from title/thesis/proposed_rule_changes keywords."""
    if not isinstance(hypothesis, dict):
        return None

    text_segments = [
        str(hypothesis.get("title", "")),
        str(hypothesis.get("thesis", "")),
    ]

    proposed_rule_changes = hypothesis.get("proposed_rule_changes")
    if isinstance(proposed_rule_changes, list):
        for row in proposed_rule_changes:
            if isinstance(row, dict):
                text_segments.append(str(row.get("change", "")))

    joined = "\n".join(text_segments).lower()
    if "gap_open_scored" in joined or "gap open scored" in joined:
        return None

    family_scores: dict[str, int] = {}
    for family, keywords in ENTRY_FAMILY_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw.lower() in joined)
        if score > 0:
            family_scores[family] = score

    if not family_scores:
        return None

    entry_logic_text = ""
    if isinstance(proposed_rule_changes, list):
        for row in proposed_rule_changes:
            if isinstance(row, dict) and str(row.get("component", "")).strip() == "entry_logic":
                entry_logic_text = str(row.get("change", "")).lower()
                break

    if len(family_scores) > 1 and entry_logic_text:
        entry_logic_matches = [
            family
            for family, keywords in ENTRY_FAMILY_KEYWORDS.items()
            if any(kw.lower() in entry_logic_text for kw in keywords)
        ]
        if len(entry_logic_matches) == 1:
            return entry_logic_matches[0]
        if len(entry_logic_matches) > 1:
            return max(entry_logic_matches, key=lambda family: family_scores.get(family, 0))

    best_score = max(family_scores.values())
    contenders = [family for family, score in family_scores.items() if score == best_score]
    if len(contenders) == 1:
        return contenders[0]

    return sorted(contenders)[0]


def can_export(hypothesis: dict) -> bool:
    """Return True if hypothesis can be exported under v1 contract constraints."""
    if not isinstance(hypothesis, dict):
        return False
    return (
        hypothesis.get("recommendation") == "pursue" and infer_entry_family(hypothesis) is not None
    )


def build_strategy_yaml(hypothesis: dict, candidate_id: str) -> dict:
    """Build strategy.yaml payload for edge-finder-candidate/v1."""
    entry_family = infer_entry_family(hypothesis)
    if entry_family not in EXPORTABLE_ENTRY_TYPES:
        raise ValueError("hypothesis is not exportable under edge-finder-candidate/v1")

    default_entry = DEFAULT_ENTRY_BY_FAMILY[entry_family]

    entry_conditions = _extract_entry_conditions(hypothesis)
    if not entry_conditions:
        entry_conditions = default_entry["conditions"]

    spec: dict[str, Any] = {
        "id": candidate_id,
        "name": str(hypothesis.get("title", candidate_id)).strip() or candidate_id,
        "description": str(hypothesis.get("thesis", "")).strip(),
        "universe": dict(DEFAULT_UNIVERSE),
        "signals": {
            "entry": {
                "type": entry_family,
                "conditions": entry_conditions,
                "trend_filter": list(default_entry["trend_filter"]),
            },
            "exit": dict(DEFAULT_EXIT),
        },
        "risk": dict(DEFAULT_RISK),
        "cost_model": dict(DEFAULT_COST_MODEL),
        "validation": {
            "method": "full_sample",
            "oos_ratio": None,
        },
        "promotion_gates": dict(DEFAULT_PROMOTION_GATES),
    }

    if entry_family == "pivot_breakout":
        spec["vcp_detection"] = dict(DEFAULT_VCP_DETECTION)
    elif entry_family == "gap_up_continuation":
        spec["gap_up_detection"] = dict(DEFAULT_GAP_DETECTION)

    return spec


def validate_strategy_yaml(spec: dict, candidate_id: str) -> list[str]:
    """Validate generated strategy yaml using edge-candidate-agent contract validator."""
    validate_interface_contract = _load_candidate_contract_validator()
    return validate_interface_contract(spec, candidate_id, stage="phase1")


def build_metadata_json(hypothesis: dict, candidate_id: str) -> dict:
    """Build metadata.json payload with provenance context."""
    entry_family = infer_entry_family(hypothesis)
    thesis = str(hypothesis.get("thesis", "")).strip()
    thesis_summary = thesis if len(thesis) <= 180 else thesis[:177] + "..."

    return {
        "interface_version": INTERFACE_VERSION,
        "candidate_id": candidate_id,
        "generated_at_utc": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "generator": {
            "name": "trade-hypothesis-ideator",
            "version": "0.1.0",
        },
        "research_context": {
            "hypothesis_id": str(hypothesis.get("hypothesis_id", "")).strip(),
            "entry_family": entry_family,
            "thesis": thesis_summary,
        },
    }


def export_candidate(hypothesis: dict, output_dir: Path, dry_run: bool = False) -> Path | None:
    """Build, validate, and write candidate artifacts from one hypothesis card."""
    if not can_export(hypothesis):
        return None

    candidate_id = _to_candidate_id(hypothesis)
    spec = build_strategy_yaml(hypothesis, candidate_id)
    errors = validate_strategy_yaml(spec, candidate_id)
    if errors:
        raise ValueError("strategy export validation failed: " + "; ".join(errors))

    metadata = build_metadata_json(hypothesis, candidate_id)

    if dry_run:
        return None

    candidate_dir = output_dir / candidate_id
    candidate_dir.mkdir(parents=True, exist_ok=True)

    strategy_path = candidate_dir / "strategy.yaml"
    metadata_path = candidate_dir / "metadata.json"

    strategy_path.write_text(
        yaml.safe_dump(spec, sort_keys=False, allow_unicode=False), encoding="utf-8"
    )
    metadata_path.write_text(
        json.dumps(metadata, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )

    return candidate_dir


def _load_candidate_contract_validator():
    if not CANDIDATE_CONTRACT_PATH.exists():
        raise RuntimeError(
            f"candidate_contract.py not found at expected path: {CANDIDATE_CONTRACT_PATH}"
        )

    module_name = "edge_candidate_contract_dynamic"
    spec = importlib.util.spec_from_file_location(module_name, CANDIDATE_CONTRACT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to build import spec for: {CANDIDATE_CONTRACT_PATH}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    validate_interface_contract = getattr(module, "validate_interface_contract", None)
    if validate_interface_contract is None:
        raise RuntimeError("candidate_contract.py missing validate_interface_contract()")

    return validate_interface_contract


def _extract_entry_conditions(hypothesis: dict) -> list[str]:
    changes = hypothesis.get("proposed_rule_changes")
    if not isinstance(changes, list):
        return []

    conditions: list[str] = []
    for row in changes:
        if not isinstance(row, dict):
            continue
        if str(row.get("component", "")).strip() != "entry_logic":
            continue
        change = str(row.get("change", "")).strip()
        if change:
            conditions.append(change)

    return conditions


def _to_candidate_id(hypothesis: dict) -> str:
    raw_id = str(hypothesis.get("hypothesis_id", "hypothesis")).strip().lower() or "hypothesis"
    norm = re.sub(r"[^a-z0-9]+", "_", raw_id).strip("_")
    return f"edge_{norm}_v1"
