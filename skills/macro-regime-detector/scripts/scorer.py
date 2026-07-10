#!/usr/bin/env python3
"""
Macro Regime Detector - Composite Scoring & Regime Classification

Combines 6 component transition signals into:
1. Weighted composite transition score (0-100)
2. Regime classification (5 regimes)
3. Transition probability assessment

Component Weights:
1. Market Concentration (RSP/SPY):    25%
2. Yield Curve (10Y-2Y):             20%
3. Credit Conditions (HYG/LQD):      15%
4. Size Factor (IWM/SPY):            15%
5. Equity-Bond (SPY/TLT+corr):       15%
6. Sector Rotation (XLY/XLP):        10%
Total: 100%

5 Regimes:
- Concentration: RSP/SPY↓, IWM/SPY↓, credit stable
- Broadening: RSP/SPY↑, IWM/SPY↑, credit stable/easing
- Contraction: Credit tight, XLY/XLP↓, SPY/TLT↓
- Inflationary: Stock-Bond positive corr, SPY/TLT↓
- Transitional: 3+ components signaling, unclear pattern
"""

from typing import Optional

COMPONENT_WEIGHTS = {
    "concentration": 0.25,
    "yield_curve": 0.20,
    "credit_conditions": 0.15,
    "size_factor": 0.15,
    "equity_bond": 0.15,
    "sector_rotation": 0.10,
}

COMPONENT_LABELS = {
    "concentration": "Market Concentration (RSP/SPY)",
    "yield_curve": "Yield Curve (10Y-2Y)",
    "credit_conditions": "Credit Conditions (HYG/LQD)",
    "size_factor": "Size Factor (IWM/SPY)",
    "equity_bond": "Equity-Bond (SPY/TLT)",
    "sector_rotation": "Sector Rotation (XLY/XLP)",
}


def calculate_composite_score(
    component_scores: dict[str, float], data_availability: Optional[dict[str, bool]] = None
) -> dict:
    """
    Calculate weighted composite transition signal score.

    Args:
        component_scores: Dict with keys matching COMPONENT_WEIGHTS, each 0-100
        data_availability: Optional dict mapping component key -> bool

    Returns:
        Dict with composite_score, zone, guidance, component breakdown, data_quality
    """
    if data_availability is None:
        data_availability = {}

    composite = 0.0
    for key, weight in COMPONENT_WEIGHTS.items():
        score = component_scores.get(key, 0)
        composite += score * weight

    composite = round(composite, 1)

    # Identify strongest and weakest signals
    valid_scores = {k: v for k, v in component_scores.items() if k in COMPONENT_WEIGHTS}

    if valid_scores:
        strongest_signal = max(valid_scores, key=valid_scores.get)
        weakest_signal = min(valid_scores, key=valid_scores.get)
    else:
        strongest_signal = "N/A"
        weakest_signal = "N/A"

    # Zone interpretation
    zone_info = _interpret_zone(composite)

    # Data quality
    available_count = sum(1 for k in COMPONENT_WEIGHTS if data_availability.get(k, True))
    total_components = len(COMPONENT_WEIGHTS)
    missing_components = [
        COMPONENT_LABELS[k] for k in COMPONENT_WEIGHTS if not data_availability.get(k, True)
    ]

    if available_count == total_components:
        quality_label = f"Complete ({available_count}/{total_components} components)"
    elif available_count >= total_components - 2:
        quality_label = (
            f"Partial ({available_count}/{total_components} components) - interpret with caution"
        )
    else:
        quality_label = (
            f"Limited ({available_count}/{total_components} components) - low confidence"
        )

    # Count components with significant signals
    signaling_count = sum(1 for v in valid_scores.values() if v >= 40)

    return {
        "composite_score": composite,
        "zone": zone_info["zone"],
        "zone_color": zone_info["color"],
        "guidance": zone_info["guidance"],
        "actions": zone_info["actions"],
        "signaling_components": signaling_count,
        "strongest_signal": {
            "component": strongest_signal,
            "label": COMPONENT_LABELS.get(strongest_signal, strongest_signal),
            "score": valid_scores.get(strongest_signal, 0),
        },
        "weakest_signal": {
            "component": weakest_signal,
            "label": COMPONENT_LABELS.get(weakest_signal, weakest_signal),
            "score": valid_scores.get(weakest_signal, 0),
        },
        "data_quality": {
            "available_count": available_count,
            "total_components": total_components,
            "label": quality_label,
            "missing_components": missing_components,
        },
        "component_scores": {
            k: {
                "score": component_scores.get(k, 0),
                "weight": w,
                "weighted_contribution": round(component_scores.get(k, 0) * w, 1),
                "label": COMPONENT_LABELS[k],
            }
            for k, w in COMPONENT_WEIGHTS.items()
        },
    }


def classify_regime(component_results: dict[str, dict]) -> dict:
    """
    Classify current macro regime based on component directions and signals.

    Only components with data_available=True contribute to regime scoring.
    Confidence is capped when data availability is limited.

    Args:
        component_results: Dict of component key -> full result dict from each calculator

    Returns:
        Dict with current_regime, confidence, evidence, transition_probability
    """
    # Extract directions and scores, treating unavailable data as neutral
    conc = component_results.get("concentration", {})
    yc = component_results.get("yield_curve", {})
    credit = component_results.get("credit_conditions", {})
    size = component_results.get("size_factor", {})
    eb = component_results.get("equity_bond", {})
    sector = component_results.get("sector_rotation", {})

    # Count available components for confidence adjustment
    available_count = sum(
        1 for comp in [conc, yc, credit, size, eb, sector] if comp.get("data_available", False)
    )

    # Only use direction from components with available data;
    # unavailable components default to "unknown" (neutral, no scoring)
    def _dir(comp: dict) -> str:
        if not comp.get("data_available", False):
            return "unknown"
        return comp.get("direction", "unknown")

    conc_dir = _dir(conc)
    yc_dir = _dir(yc)
    credit_dir = _dir(credit)
    size_dir = _dir(size)
    eb_dir = _dir(eb)
    sector_dir = _dir(sector)
    corr_regime = (
        eb.get("correlation_regime", "unknown") if eb.get("data_available", False) else "unknown"
    )

    # Score each regime hypothesis
    regime_scores = {
        "concentration": _score_concentration_regime(conc_dir, size_dir, credit_dir),
        "broadening": _score_broadening_regime(conc_dir, size_dir, credit_dir, sector_dir, yc_dir),
        "contraction": _score_contraction_regime(credit_dir, sector_dir, eb_dir, size_dir, yc_dir),
        "inflationary": _score_inflationary_regime(corr_regime, eb_dir),
        "transitional": 0,  # Computed below
    }

    # Count signaling components
    all_scores = [
        conc.get("score", 0),
        yc.get("score", 0),
        credit.get("score", 0),
        size.get("score", 0),
        eb.get("score", 0),
        sector.get("score", 0),
    ]
    signaling = sum(1 for s in all_scores if s >= 40)

    # Find best matching regime (excluding transitional for ranking)
    scored = {k: v for k, v in regime_scores.items() if k != "transitional"}
    sorted_regimes = sorted(scored.items(), key=lambda x: x[1], reverse=True)

    best_regime = sorted_regimes[0][0]
    best_score = sorted_regimes[0][1]

    # Tiebreak detection: top 2 regimes within 1 point
    is_tied = (
        len(sorted_regimes) >= 2 and best_score > 0 and (best_score - sorted_regimes[1][1]) <= 1
    )
    tied_regimes = [sorted_regimes[0][0], sorted_regimes[1][0]] if is_tied else None

    # Quick composite for tiebreak resolution
    quick_composite = sum(
        comp.get("score", 0) * COMPONENT_WEIGHTS[k]
        for k, comp in component_results.items()
        if k in COMPONENT_WEIGHTS
    )

    # Tiebreak + low composite → transitional
    if is_tied and quick_composite < 50:
        best_regime = "transitional"
        regime_scores["transitional"] = best_score

    # Fallback: multiple signals but no clear regime pattern
    elif signaling >= 3 and best_score < 3:
        best_regime = "transitional"
        best_score = signaling

    # Confidence level (capped by data availability)
    if best_score >= 4:
        confidence = "high"
    elif best_score >= 3:
        confidence = "moderate"
    elif best_score >= 2:
        confidence = "low"
    else:
        confidence = "very_low"

    # Cap confidence when regime classification is ambiguous
    if is_tied and confidence == "high":
        confidence = "moderate"

    # Cap confidence when data is limited
    if available_count <= 3:
        # With 3 or fewer components, never report above "very_low"
        confidence = "very_low"
    elif available_count <= 4:
        # With 4 components, cap at "low"
        if confidence in ("high", "moderate"):
            confidence = "low"

    # Transition probability
    transition_prob = _calculate_transition_probability(
        signaling, all_scores, regime_scores, best_regime, sorted_regimes
    )

    # Evidence summary
    evidence = _build_evidence(component_results)

    # Regime description
    regime_info = REGIME_DESCRIPTIONS.get(best_regime, {})

    return {
        "current_regime": best_regime,
        "regime_label": regime_info.get("label", best_regime),
        "regime_description": regime_info.get("description", ""),
        "confidence": confidence,
        "regime_scores": regime_scores,
        "signaling_components": signaling,
        "transition_probability": transition_prob,
        "portfolio_posture": regime_info.get("portfolio_posture", ""),
        "evidence": evidence,
        "tied_regimes": tied_regimes,
    }


REGIME_DESCRIPTIONS = {
    "concentration": {
        "label": "Concentration",
        "description": "Market leadership concentrated in mega-cap stocks. RSP/SPY declining, "
        "small-caps underperforming. Credit conditions stable.",
        "portfolio_posture": "Focus on mega-cap tech/growth leaders. "
        "Underweight small-caps and value.",
    },
    "broadening": {
        "label": "Broadening",
        "description": "Market participation expanding. RSP/SPY rising, small-caps catching up. "
        "Credit easing or stable.",
        "portfolio_posture": "Add small-cap/mid-cap exposure. Equal-weight strategies. "
        "Value and cyclical rotation.",
    },
    "contraction": {
        "label": "Contraction",
        "description": "Credit tightening, defensive rotation, equity-bond shift to risk-off. "
        "Classic late-cycle deterioration.",
        "portfolio_posture": "Raise cash. Duration management: short-duration Treasuries as base; "
        "add TIPS if inflation signals present; extend duration only when "
        "stock-bond correlation turns negative. "
        "Defensive sectors: prioritize Staples and Healthcare.",
    },
    "inflationary": {
        "label": "Inflationary",
        "description": "Positive stock-bond correlation regime. Both equities and bonds under "
        "pressure. Traditional hedging breaks down.",
        "portfolio_posture": "Real assets, commodities, energy. Short-duration bonds. "
        "TIPS. Reduce long-duration exposure.",
    },
    "transitional": {
        "label": "Transitional",
        "description": "Multiple components signaling change but no clear regime pattern. "
        "Market in flux between regimes.",
        "portfolio_posture": "Increase diversification. Gradual repositioning. "
        "Avoid concentrated bets. Monitor weekly for regime clarity.",
    },
}


def _score_concentration_regime(conc_dir: str, size_dir: str, credit_dir: str) -> int:
    """Score evidence for Concentration regime.

    Only scores when direction is known. 'unknown' (missing data) is neutral.
    """
    score = 0
    if conc_dir == "concentrating":
        score += 2
    if size_dir == "large_cap_leading":
        score += 2
    if credit_dir in ("stable", "easing"):
        score += 1
    return score


def _score_broadening_regime(
    conc_dir: str, size_dir: str, credit_dir: str, sector_dir: str, yc_dir: str = "unknown"
) -> int:
    """Score evidence for Broadening regime."""
    score = 0
    if conc_dir == "broadening":
        score += 2
    if size_dir == "small_cap_leading":
        score += 2
    if credit_dir in ("stable", "easing"):
        score += 1
    if sector_dir == "risk_on":
        score += 1
    if yc_dir == "steepening":
        score += 1
    return score


def _score_contraction_regime(
    credit_dir: str,
    sector_dir: str,
    eb_dir: str,
    size_dir: str = "unknown",
    yc_dir: str = "unknown",
) -> int:
    """Score evidence for Contraction regime.

    Small-cap leadership (size_dir='small_cap_leading') is a contradiction:
    broad small-cap strength is inconsistent with economic contraction.
    """
    score = 0
    if credit_dir == "tightening":
        score += 2
    if sector_dir == "risk_off":
        score += 2
    if eb_dir == "risk_off":
        score += 1
    if yc_dir == "flattening":
        score += 1
    # Contradiction: small-cap outperformance is inconsistent with contraction
    if size_dir == "small_cap_leading":
        score -= 1
    return max(0, score)


def _score_inflationary_regime(corr_regime: str, eb_dir: str) -> int:
    """Score evidence for Inflationary regime."""
    score = 0
    if corr_regime == "positive":
        score += 3
    elif corr_regime == "near_zero":
        score += 1
    if eb_dir == "risk_off":
        score += 1
    return score


def _calculate_transition_probability(
    signaling: int,
    all_scores: list[float],
    regime_scores: dict[str, int],
    current_regime: str,
    sorted_regimes: Optional[list] = None,
) -> dict:
    """
    Calculate probability that a regime transition is underway.

    Returns dict with probability level, supporting metrics, and transition direction.
    """
    avg_score = sum(all_scores) / len(all_scores) if all_scores else 0

    # High probability: many components signaling + high average score
    if signaling >= 4 and avg_score >= 50:
        prob_level = "high"
        prob_pct = "70-90%"
    elif signaling >= 3 and avg_score >= 40:
        prob_level = "moderate"
        prob_pct = "40-60%"
    elif signaling >= 2 and avg_score >= 30:
        prob_level = "low"
        prob_pct = "20-40%"
    else:
        prob_level = "minimal"
        prob_pct = "<20%"

    # Check if second-best regime is close (ambiguity)
    if sorted_regimes is None:
        scored = {k: v for k, v in regime_scores.items() if k != "transitional"}
        sorted_regimes = sorted(scored.items(), key=lambda x: x[1], reverse=True)

    ambiguity = False
    if len(sorted_regimes) >= 2:
        best_val = sorted_regimes[0][1]
        second_val = sorted_regimes[1][1]
        if best_val > 0 and second_val >= best_val - 1:
            ambiguity = True

    # Transition direction
    from_regime = None
    to_regime = None
    if prob_level in ("high", "moderate") and sorted_regimes:
        top = sorted_regimes[0][0]
        if current_regime == "transitional" and len(sorted_regimes) >= 2:
            to_regime = top
            from_regime = sorted_regimes[1][0] if sorted_regimes[1][1] > 0 else None
        elif top != current_regime:
            from_regime = current_regime
            to_regime = top

    return {
        "level": prob_level,
        "probability_range": prob_pct,
        "signaling_count": signaling,
        "avg_component_score": round(avg_score, 1),
        "ambiguous": ambiguity,
        "from_regime": from_regime,
        "to_regime": to_regime,
    }


REGIME_CONSISTENCY = {
    "broadening": {
        "concentration": "broadening",
        "size_factor": "small_cap_leading",
        "credit_conditions": ["stable", "easing"],
        "sector_rotation": "risk_on",
        "equity_bond": "risk_on",
        "yield_curve": "steepening",
    },
    "concentration": {
        "concentration": "concentrating",
        "size_factor": "large_cap_leading",
        "credit_conditions": ["stable", "easing"],
    },
    "contraction": {
        "credit_conditions": "tightening",
        "sector_rotation": "risk_off",
        "equity_bond": "risk_off",
        "yield_curve": ["flattening"],
    },
    "inflationary": {
        "equity_bond": "risk_off",
    },
    "transitional": {},
}


def check_regime_consistency(
    current_regime: str, component_results: dict[str, dict]
) -> dict[str, str]:
    """
    Check whether each component's direction is consistent with the classified regime.

    Returns:
        Dict mapping component key -> "consistent" | "contradicting" | "neutral"
    """
    expected = REGIME_CONSISTENCY.get(current_regime, {})
    result = {}

    for key in COMPONENT_WEIGHTS:
        comp = component_results.get(key, {})
        direction = comp.get("direction", "unknown")

        if key not in expected:
            result[key] = "neutral"
            continue

        exp_dir = expected[key]
        if isinstance(exp_dir, list):
            if direction in exp_dir:
                result[key] = "consistent"
            elif direction == "unknown":
                result[key] = "neutral"
            else:
                result[key] = "contradicting"
        else:
            if direction == exp_dir:
                result[key] = "consistent"
            elif direction == "unknown":
                result[key] = "neutral"
            else:
                result[key] = "contradicting"

    return result


def _build_evidence(component_results: dict[str, dict]) -> list[dict]:
    """Build evidence list from component results."""
    evidence = []
    for key in COMPONENT_WEIGHTS:
        comp = component_results.get(key, {})
        if not comp:
            continue
        score = comp.get("score", 0)
        if score >= 40:
            evidence.append(
                {
                    "component": COMPONENT_LABELS.get(key, key),
                    "score": score,
                    "signal": comp.get("signal", ""),
                    "direction": comp.get("direction", "unknown"),
                }
            )
    # Sort by score descending
    evidence.sort(key=lambda x: x["score"], reverse=True)
    return evidence


def _interpret_zone(composite: float) -> dict:
    """Map composite score to transition signal zone."""
    if composite <= 20:
        return {
            "zone": "Stable (No Transition)",
            "color": "green",
            "guidance": "All indicators stable. Current regime well-established.",
            "actions": [
                "Maintain current portfolio posture",
                "Standard rebalancing schedule",
                "Monitor monthly for early signals",
            ],
        }
    elif composite <= 40:
        return {
            "zone": "Early Signal (Monitoring)",
            "color": "yellow",
            "guidance": "Minor shifts detected. Worth monitoring but not actionable yet.",
            "actions": [
                "Increase monitoring frequency to bi-weekly",
                "Review portfolio for regime sensitivity",
                "Identify potential adjustment triggers",
                "No position changes needed yet",
            ],
        }
    elif composite <= 60:
        return {
            "zone": "Transition Zone (Preparing)",
            "color": "orange",
            "guidance": "Multiple indicators in transition. Begin planning portfolio adjustment.",
            "actions": [
                "Develop regime-change response plan",
                "Begin gradual diversification shifts",
                "Reduce concentrated bets",
                "Identify new regime beneficiaries",
                "Weekly monitoring",
            ],
        }
    elif composite <= 80:
        return {
            "zone": "Active Transition (Repositioning)",
            "color": "red",
            "guidance": "Clear regime transition underway. Execute repositioning plan.",
            "actions": [
                "Execute planned portfolio adjustments",
                "Rotate toward new regime beneficiaries",
                "Reduce exposure to old regime leaders",
                "Increase hedging if contracting/inflationary",
                "Daily monitoring of confirmation signals",
            ],
        }
    else:
        return {
            "zone": "Confirmed Transition (Completing)",
            "color": "critical",
            "guidance": "Strong confirmed transition. Complete repositioning.",
            "actions": [
                "Finalize portfolio repositioning",
                "Full allocation to new regime posture",
                "Monitor for transition exhaustion signals",
                "Prepare for new regime stability",
            ],
        }
