#!/usr/bin/env python3
"""
Market Breadth Analyzer - Composite Scoring Engine

Combines 6 component scores into a weighted composite (0-100).
Score direction: 100 = Healthy, 0 = Critical (breadth is a health indicator).

Component Weights:
1. Current Breadth Level & Trend:  25%
2. 8MA vs 200MA Crossover:        20%
3. Peak/Trough Cycle Position:    20%
4. Bearish Signal Status:         15%
5. Historical Percentile:         10%
6. S&P 500 vs Breadth Divergence: 10%
Total: 100%

When a component has data_available=False, its weight is proportionally
redistributed among the remaining available components.

Health Zone Mapping (100 = Healthy):
  80-100: Strong    - Full equity exposure
  60-79:  Healthy   - Normal operations
  40-59:  Neutral   - Selective positioning
  20-39:  Weakening - Profit-taking, raise cash
  0-19:   Critical  - Capital preservation
"""

from typing import Optional

COMPONENT_WEIGHTS = {
    "breadth_level_trend": 0.25,
    "ma_crossover": 0.20,
    "cycle_position": 0.20,
    "bearish_signal": 0.15,
    "historical_percentile": 0.10,
    "divergence": 0.10,
}

COMPONENT_LABELS = {
    "breadth_level_trend": "Current Breadth Level & Trend",
    "ma_crossover": "8MA vs 200MA Crossover",
    "cycle_position": "Peak/Trough Cycle Position",
    "bearish_signal": "Bearish Signal Status",
    "historical_percentile": "Historical Percentile",
    "divergence": "S&P 500 vs Breadth Divergence",
}


def calculate_composite_score(
    component_scores: dict[str, float],
    data_availability: Optional[dict[str, bool]] = None,
) -> dict:
    """
    Calculate weighted composite market breadth health score.

    Args:
        component_scores: Dict with keys matching COMPONENT_WEIGHTS, each 0-100.
        data_availability: Optional dict mapping component key -> bool.
            When a component is False, its weight is redistributed proportionally.

    Returns:
        Dict with composite_score, zone, exposure_guidance, guidance,
        strongest/weakest components, component breakdown, and data_quality.
    """
    if data_availability is None:
        data_availability = {}

    # Determine which components are available
    available = {k: data_availability.get(k, True) for k in COMPONENT_WEIGHTS}

    # Calculate sum of available weights for redistribution
    available_total_weight = sum(w for k, w in COMPONENT_WEIGHTS.items() if available[k])

    # Build effective weights
    effective_weights = {}
    for key, weight in COMPONENT_WEIGHTS.items():
        if not available[key]:
            effective_weights[key] = 0.0
        elif available_total_weight > 0:
            effective_weights[key] = weight / available_total_weight
        else:
            effective_weights[key] = 0.0

    # Excluded components
    excluded_components = [COMPONENT_LABELS[k] for k in COMPONENT_WEIGHTS if not available[k]]

    # Zero-division guard: all components unavailable
    if available_total_weight == 0:
        composite = 50.0
        zone_info = _interpret_zone(composite)
        # Override zone to Neutral with warning
        zone_info["zone"] = "Neutral"
        zone_info["guidance"] = (
            "All component data is unavailable. Score is a reference value only."
        )
    else:
        # Weighted composite using effective weights
        composite = 0.0
        for key in COMPONENT_WEIGHTS:
            score = component_scores.get(key, 50)
            composite += score * effective_weights[key]
        composite = round(composite, 1)
        zone_info = _interpret_zone(composite)

    # Identify strongest and weakest among AVAILABLE components only
    valid_scores = {
        k: v
        for k, v in component_scores.items()
        if k in COMPONENT_WEIGHTS and available.get(k, True)
    }

    if valid_scores:
        strongest_health = max(valid_scores, key=valid_scores.get)
        weakest_health = min(valid_scores, key=valid_scores.get)
    else:
        strongest_health = "N/A"
        weakest_health = "N/A"

    # Data quality
    available_count = sum(1 for k in COMPONENT_WEIGHTS if available[k])
    total_components = len(COMPONENT_WEIGHTS)
    missing_components = [COMPONENT_LABELS[k] for k in COMPONENT_WEIGHTS if not available[k]]

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

    data_quality = {
        "available_count": available_count,
        "total_components": total_components,
        "label": quality_label,
        "missing_components": missing_components,
    }

    return {
        "composite_score": composite,
        "zone": zone_info["zone"],
        "zone_color": zone_info["color"],
        "exposure_guidance": zone_info["exposure_guidance"],
        "guidance": zone_info["guidance"],
        "actions": zone_info["actions"],
        "strongest_health": {
            "component": strongest_health,
            "label": COMPONENT_LABELS.get(strongest_health, strongest_health),
            "score": valid_scores.get(strongest_health, 0),
        },
        "weakest_health": {
            "component": weakest_health,
            "label": COMPONENT_LABELS.get(weakest_health, weakest_health),
            "score": valid_scores.get(weakest_health, 0),
        },
        "excluded_components": excluded_components,
        "data_quality": data_quality,
        "component_scores": {
            k: {
                "score": component_scores.get(k, 50),
                "weight": w,
                "effective_weight": round(effective_weights[k], 6),
                "weighted_contribution": round(
                    component_scores.get(k, 50) * effective_weights[k], 1
                ),
                "data_available": available[k],
                "label": COMPONENT_LABELS[k],
            }
            for k, w in COMPONENT_WEIGHTS.items()
        },
    }


def _interpret_zone(composite: float) -> dict:
    """Map composite score to health zone (100 = healthy)."""
    if composite >= 80:
        return {
            "zone": "Strong",
            "color": "green",
            "exposure_guidance": "90-100%",
            "guidance": ("Broad market participation. Maintain full equity exposure."),
            "actions": [
                "Full position sizing allowed",
                "New entries on pullbacks encouraged",
                "Wide stop-losses acceptable",
                "Growth and momentum strategies favored",
            ],
        }
    elif composite >= 60:
        return {
            "zone": "Healthy",
            "color": "blue",
            "exposure_guidance": "75-90%",
            "guidance": ("Above-average breadth. Normal operations with standard risk management."),
            "actions": [
                "Normal position sizing",
                "Standard stop-loss levels",
                "New position entries allowed",
                "Monitor for deterioration in leading indicators",
            ],
        }
    elif composite >= 40:
        return {
            "zone": "Neutral",
            "color": "yellow",
            "exposure_guidance": "60-75%",
            "guidance": (
                "Mixed signals. Be selective with new positions and tighten risk controls."
            ),
            "actions": [
                "Reduce new position sizes by 25-50%",
                "Tighten stop-losses",
                "Focus on stocks with strong relative strength",
                "Avoid lagging sectors and speculative names",
            ],
        }
    elif composite >= 20:
        return {
            "zone": "Weakening",
            "color": "orange",
            "exposure_guidance": "40-60%",
            "guidance": ("Breadth deteriorating. Begin profit-taking and raise cash allocation."),
            "actions": [
                "Take profits on weakest 25-40% of positions",
                "No new momentum entries",
                "Raise cash allocation significantly",
                "Consider defensive sector rotation (XLU, XLP, XLV)",
                "Watch for cycle trough signal for re-entry",
            ],
        }
    else:
        return {
            "zone": "Critical",
            "color": "red",
            "exposure_guidance": "25-40%",
            "guidance": (
                "Severe breadth weakness. Capital preservation is the priority. "
                "Watch for trough formation as re-entry signal."
            ),
            "actions": [
                "Maximum cash allocation (60-75%)",
                "Only hold strongest relative strength leaders",
                "Consider hedges (put options, inverse ETFs)",
                "Monitor for extreme trough (8MA < 0.4) as contrarian buy signal",
                "Prepare watchlist for recovery: quality stocks near support",
            ],
        }
