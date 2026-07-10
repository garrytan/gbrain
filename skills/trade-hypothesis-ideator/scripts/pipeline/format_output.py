"""Output bundle validation, guardrails, and report formatting (Step G)."""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

BANNED_PHRASES = [
    "本番投入可能",
    "確実に勝てる",
    "production ready",
    "guaranteed edge",
    "sure to win",
    "guaranteed profit",
]

_REQUIRED_CARD_FIELDS = (
    "hypothesis_id",
    "title",
    "thesis",
    "problem_target",
    "mechanism",
    "evidence_basis",
    "proposed_rule_changes",
    "expected_impact",
    "key_risks",
    "kill_criteria",
    "minimum_viable_experiment",
    "score_components",
    "priority_score",
    "recommendation",
    "rationale",
    "confidence",
    "assumptions",
    "dependencies",
)

_REQUIRED_MVE_FIELDS = ("goal", "setup", "metrics", "sample_size", "duration")
_ALLOWED_RECOMMENDATIONS = {"pursue", "park", "reject"}


def validate_hypothesis_card(card: dict) -> list[str]:
    """Validate a single hypothesis card payload."""
    errors: list[str] = []

    if not isinstance(card, dict):
        return ["card must be an object"]

    for key in _REQUIRED_CARD_FIELDS:
        if key not in card:
            errors.append(f"{key} is required")

    evidence_basis = card.get("evidence_basis")
    if not isinstance(evidence_basis, list) or len(evidence_basis) < 1:
        errors.append("evidence_basis must be a non-empty list")

    kill_criteria = card.get("kill_criteria")
    if not isinstance(kill_criteria, list) or len(kill_criteria) < 1:
        errors.append("kill_criteria must be a non-empty list")

    mve = card.get("minimum_viable_experiment")
    if not isinstance(mve, dict):
        errors.append("minimum_viable_experiment must be an object")
    else:
        for key in _REQUIRED_MVE_FIELDS:
            value = mve.get(key)
            if value is None or (isinstance(value, str) and not value.strip()):
                errors.append(f"minimum_viable_experiment.{key} is required")

    recommendation = card.get("recommendation")
    if recommendation not in _ALLOWED_RECOMMENDATIONS:
        errors.append(
            f"recommendation must be one of: {', '.join(sorted(_ALLOWED_RECOMMENDATIONS))}"
        )

    for phrase in _find_banned_phrases(card):
        errors.append(f"banned phrase detected in card: {phrase}")

    return errors


def check_constraint_violations(card: dict, constraints: dict) -> list[str]:
    """Check whether a hypothesis conflicts with execution/data/risk constraints."""
    issues: list[str] = []

    if not isinstance(card, dict) or not isinstance(constraints, dict):
        return issues

    all_text = "\n".join(_extract_string_values(card)).lower()

    for constraint in _as_str_list(constraints.get("data_constraints")):
        c_lower = constraint.lower()
        if "sub-second" in c_lower or "tick" in c_lower:
            if any(
                token in all_text for token in ("tick", "tick-level", "sub-second", "millisecond")
            ):
                issues.append(
                    "data constraint violation: "
                    f"'{constraint}' conflicts with tick/sub-second requirement in hypothesis"
                )

    for constraint in _as_str_list(constraints.get("risk_constraints")):
        c_lower = constraint.lower()

        max_pos = _parse_max_positions(c_lower)
        if max_pos is not None:
            proposed_positions = _find_position_counts(all_text)
            for proposed in proposed_positions:
                if proposed > max_pos:
                    issues.append(
                        f"risk constraint violation: '{constraint}' but proposal references {proposed} positions"
                    )

        max_position_size = _parse_max_position_size_pct(c_lower)
        if max_position_size is not None:
            for pct in _find_position_size_pcts(all_text):
                if pct > max_position_size:
                    issues.append(
                        "risk constraint violation: "
                        f"'{constraint}' but proposal references position size {pct:.1f}%"
                    )

    return issues


def check_duplicate_hypotheses(hypotheses: list[dict]) -> list[str]:
    """Detect duplicate hypotheses by id, title similarity, and mechanism tuple."""
    issues: list[str] = []

    id_to_first_index: dict[str, int] = {}
    norm_title_entries: list[tuple[int, str, str]] = []
    mechanism_pairs: dict[tuple[str, str], int] = {}

    for idx, card in enumerate(hypotheses):
        if not isinstance(card, dict):
            issues.append(f"hypotheses[{idx}] must be an object")
            continue

        hypothesis_id = str(card.get("hypothesis_id", "")).strip()
        if hypothesis_id:
            if hypothesis_id in id_to_first_index:
                first = id_to_first_index[hypothesis_id]
                issues.append(
                    "duplicate hypothesis_id detected: "
                    f"'{hypothesis_id}' at indices {first} and {idx}"
                )
            else:
                id_to_first_index[hypothesis_id] = idx

        title = _normalize_title_for_similarity(str(card.get("title", "")))
        if title:
            norm_title_entries.append((idx, hypothesis_id or f"idx-{idx}", title))

        problem_target = _normalize_text(str(card.get("problem_target", "")))
        mechanism = _normalize_text(str(card.get("mechanism", "")))
        pair = (problem_target, mechanism)
        if pair != ("", ""):
            if pair in mechanism_pairs:
                first = mechanism_pairs[pair]
                issues.append(
                    f"duplicate problem_target+mechanism detected between indices {first} and {idx}"
                )
            else:
                mechanism_pairs[pair] = idx

    for i, (_, id_a, title_a) in enumerate(norm_title_entries):
        for _, id_b, title_b in norm_title_entries[i + 1 :]:
            ratio = SequenceMatcher(None, title_a, title_b).ratio()
            if ratio > 0.8:
                issues.append(
                    f"potential duplicate title pair: {id_a} vs {id_b} (similarity={ratio:.2f})"
                )

    return issues


def validate_output_bundle(bundle: dict, constraints: dict | None = None) -> list[str]:
    """Validate output bundle shape plus all guardrails."""
    errors: list[str] = []

    if not isinstance(bundle, dict):
        return ["output bundle must be an object"]

    hypotheses = bundle.get("hypotheses")
    if not isinstance(hypotheses, list):
        errors.append("hypotheses must be an array")
        hypotheses = []
    elif not (1 <= len(hypotheses) <= 5):
        errors.append("hypotheses must contain 1-5 cards")

    summary = bundle.get("summary", "")
    state_assessment = bundle.get("state_assessment", "")
    for phrase in _find_banned_phrases({"summary": summary, "state_assessment": state_assessment}):
        errors.append(f"banned phrase detected in bundle: {phrase}")

    for idx, card in enumerate(hypotheses):
        card_errors = validate_hypothesis_card(card)
        errors.extend([f"hypotheses[{idx}]: {msg}" for msg in card_errors])

    errors.extend(check_duplicate_hypotheses(hypotheses))

    if constraints is not None:
        for idx, card in enumerate(hypotheses):
            issues = check_constraint_violations(card, constraints)
            errors.extend([f"hypotheses[{idx}]: {issue}" for issue in issues])

    return errors


def build_logging_payload(bundle: dict, normalized_input: dict) -> dict:
    """Build journal-compatible logging payload."""
    objective = ""
    if isinstance(normalized_input, dict):
        objective_obj = normalized_input.get("objective")
        if isinstance(objective_obj, dict):
            objective = str(objective_obj.get("goal", "")).strip()

    hypothesis_ids = [
        str(card.get("hypothesis_id"))
        for card in bundle.get("hypotheses", [])
        if isinstance(card, dict) and card.get("hypothesis_id")
    ]

    candidate_sources = (
        "strategy_context",
        "constraints",
        "market_context",
        "performance_summary",
        "trade_log_summary",
        "feature_inventory",
        "journal_snippets",
        "qualitative_notes",
        "artifacts",
    )
    sources_used: list[str] = []
    for key in candidate_sources:
        value = normalized_input.get(key) if isinstance(normalized_input, dict) else None
        if value not in (None, [], {}, ""):
            sources_used.append(key)

    return {
        "objective": objective,
        "sources_used": sources_used,
        "hypothesis_ids": hypothesis_ids,
        "selected_next_actions": _as_str_list(bundle.get("selected_next_actions")),
        "warnings": _as_str_list(bundle.get("warnings")),
    }


def build_markdown_report(bundle: dict) -> str:
    """Build a readable markdown report for hypothesis outcomes."""
    lines: list[str] = ["# Trade Hypothesis Report", "", "## Summary"]

    lines.append(str(bundle.get("summary", "")) or "(none)")
    lines.extend(["", "## State Assessment", str(bundle.get("state_assessment", "")) or "(none)"])
    lines.extend(["", "## Hypotheses"])

    hypotheses = bundle.get("hypotheses", [])
    if not isinstance(hypotheses, list) or not hypotheses:
        lines.append("- (none)")
    else:
        for card in hypotheses:
            if not isinstance(card, dict):
                continue
            hid = card.get("hypothesis_id", "unknown")
            title = card.get("title", "untitled")
            recommendation = card.get("recommendation", "unknown")
            priority = card.get("priority_score", "n/a")
            lines.append(f"### {hid}: {title}")
            lines.append(f"- Recommendation: {recommendation}")
            lines.append(f"- Priority Score: {priority}")
            lines.append(f"- Thesis: {card.get('thesis', '')}")
            lines.append(f"- Mechanism: {card.get('mechanism', '')}")
            lines.append(f"- Expected Impact: {card.get('expected_impact', '')}")
            lines.append("")

    lines.append("## Risks")
    risks: list[str] = []
    for card in hypotheses if isinstance(hypotheses, list) else []:
        if isinstance(card, dict):
            risks.extend(_as_str_list(card.get("key_risks")))

    if not risks:
        lines.append("- (none)")
    else:
        for risk in dict.fromkeys(risks):
            lines.append(f"- {risk}")

    lines.append("")
    lines.append("## Next Actions")
    actions = _as_str_list(bundle.get("selected_next_actions"))
    if not actions:
        lines.append("- (none)")
    else:
        lines.extend(f"- {action}" for action in actions)

    return "\n".join(lines).strip() + "\n"


def _find_banned_phrases(obj: Any) -> list[str]:
    text = "\n".join(_extract_string_values(obj)).lower()
    found: list[str] = []
    for phrase in BANNED_PHRASES:
        if phrase.lower() in text:
            found.append(phrase)
    return found


def _extract_string_values(obj: Any) -> list[str]:
    values: list[str] = []

    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        for value in obj.values():
            values.extend(_extract_string_values(value))
    elif isinstance(obj, list):
        for value in obj:
            values.extend(_extract_string_values(value))

    return values


def _as_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if isinstance(item, str) and str(item).strip()]


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def _normalize_title_for_similarity(value: str) -> str:
    base = re.sub(r"[^a-z0-9\s]+", " ", value.lower())
    tokens = [token for token in base.split() if token]
    stop_words = {
        "based",
        "entry",
        "entries",
        "setup",
        "signal",
        "signals",
        "strategy",
        "rule",
        "rules",
        "approach",
    }
    filtered = [token for token in tokens if token not in stop_words]
    if not filtered:
        filtered = tokens
    return " ".join(filtered)


def _parse_max_positions(text: str) -> int | None:
    match = re.search(r"max\s+(\d+)\s+(?:concurrent\s+)?positions?", text)
    if not match:
        return None
    return int(match.group(1))


def _find_position_counts(text: str) -> list[int]:
    matches = re.findall(r"(\d+)\s+positions?", text)
    return [int(match) for match in matches]


def _parse_max_position_size_pct(text: str) -> float | None:
    patterns = (
        r"max\s+single-position\s+size\s*(\d+(?:\.\d+)?)%",
        r"max\s+position\s+size\s*(\d+(?:\.\d+)?)%",
        r"max\s*(\d+(?:\.\d+)?)%\s+position",
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return float(match.group(1))
    return None


def _find_position_size_pcts(text: str) -> list[float]:
    matches = re.findall(r"(\d+(?:\.\d+)?)%\s+(?:position|allocation|capital)", text)
    return [float(match) for match in matches]
