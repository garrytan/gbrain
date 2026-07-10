"""Extract and format evidence signals from normalized input bundle."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class EvidenceSummary:
    """Canonical evidence summary used by prompt generation."""

    primary_issues: list[str]
    regime_characteristics: list[str]
    winning_patterns: list[str]
    losing_patterns: list[str]
    available_features: list[str]
    rejected_directions: list[str]
    execution_constraints: list[str]


def extract_evidence(normalized: dict) -> EvidenceSummary:
    """Extract structured evidence fields from a normalized input bundle."""
    strategy_context = normalized.get("strategy_context") if isinstance(normalized, dict) else {}
    market_context = normalized.get("market_context") if isinstance(normalized, dict) else {}
    trade_log_summary = normalized.get("trade_log_summary") if isinstance(normalized, dict) else {}
    constraints = normalized.get("constraints") if isinstance(normalized, dict) else {}

    strategy_context = strategy_context if isinstance(strategy_context, dict) else {}
    market_context = market_context if isinstance(market_context, dict) else {}
    trade_log_summary = trade_log_summary if isinstance(trade_log_summary, dict) else {}
    constraints = constraints if isinstance(constraints, dict) else {}

    primary_issues = _as_list_of_str(strategy_context.get("known_pain_points"))

    regime_characteristics = _as_list_of_str(market_context.get("regime_tags")) + _as_list_of_str(
        market_context.get("observations")
    )

    winning_patterns = _as_list_of_str(trade_log_summary.get("common_winner_traits"))
    losing_patterns = _as_list_of_str(trade_log_summary.get("common_loser_traits"))

    available_features = _as_list_of_str(normalized.get("feature_inventory"))

    rejected_directions: list[str] = []
    for snippet in normalized.get("journal_snippets", []):
        if not isinstance(snippet, dict):
            continue
        outcome = str(snippet.get("outcome", "")).strip().lower()
        if outcome == "promising":
            continue
        note = str(snippet.get("note", "")).strip()
        if note:
            rejected_directions.append(f"[{outcome or 'unknown'}] {note}")

    execution_constraints = _as_list_of_str(
        constraints.get("execution_constraints")
    ) + _as_list_of_str(constraints.get("risk_constraints"))

    return EvidenceSummary(
        primary_issues=primary_issues,
        regime_characteristics=regime_characteristics,
        winning_patterns=winning_patterns,
        losing_patterns=losing_patterns,
        available_features=available_features,
        rejected_directions=rejected_directions,
        execution_constraints=execution_constraints,
    )


def format_evidence_for_prompt(summary: EvidenceSummary) -> str:
    """Format evidence summary into a deterministic prompt-friendly markdown block."""
    sections = [
        ("Primary issues", summary.primary_issues),
        ("Regime characteristics", summary.regime_characteristics),
        ("Winning patterns", summary.winning_patterns),
        ("Losing patterns", summary.losing_patterns),
        ("Available features", summary.available_features),
        ("Rejected directions", summary.rejected_directions),
        ("Execution constraints", summary.execution_constraints),
    ]

    lines: list[str] = []
    for title, items in sections:
        lines.append(f"## {title}")
        if not items:
            lines.append("- (none)")
        else:
            lines.extend(f"- {item}" for item in items)
        lines.append("")

    return "\n".join(lines).strip() + "\n"


def _as_list_of_str(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item.strip()]
