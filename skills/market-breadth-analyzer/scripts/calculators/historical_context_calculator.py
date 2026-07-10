#!/usr/bin/env python3
"""
Component 5: Historical Percentile (Weight: 10%)

Determines where the current breadth level sits in the full historical distribution.

Input: Breadth_Index_8MA (all rows), Summary CSV (average peak/trough values)

Scoring (100 = healthy):
  Percentile rank of current 8MA among all historical 8MA values:
    >= 80th -> 90    >= 60th -> 70    >= 40th -> 50
    >= 20th -> 30    <  20th -> 10

  Adjustment:
    Current >= avg_peak * 0.95 -> -10 (overheated caution)
    Current <= avg_trough * 1.05 -> +10 (oversold zone)
"""

from typing import Optional


def calculate_historical_percentile(
    rows: list[dict],
    summary: dict[str, str],
) -> dict:
    """
    Calculate historical percentile score.

    Args:
        rows: All detail rows sorted by date ascending.
        summary: Summary CSV as dict {Metric: Value}.

    Returns:
        Dict with score, signal, and component details.
    """
    if not rows:
        return {
            "score": 50,
            "signal": "NO DATA: No data available for historical analysis",
            "data_available": False,
        }

    # Extract all 8MA values
    all_8ma = [r["Breadth_Index_8MA"] for r in rows]
    current_8ma = all_8ma[-1]

    # Calculate percentile rank
    below_count = sum(1 for v in all_8ma if v < current_8ma)
    percentile = (below_count / len(all_8ma)) * 100

    # Base score from percentile
    base_score = _score_percentile(percentile)

    # Parse summary values
    avg_peak = _safe_float(summary.get("Average Peaks (200MA)", ""))
    avg_trough = _safe_float(summary.get("Average Troughs (8MA < 0.4)", ""))

    # Adjustment for extremes
    adjustment = 0
    if avg_peak is not None and current_8ma >= avg_peak * 0.95:
        adjustment = -10  # Overheated
    elif avg_trough is not None and current_8ma <= avg_trough * 1.05:
        adjustment = +10  # Oversold

    score = round(base_score + adjustment)
    score = max(0, min(100, score))

    signal = _generate_signal(percentile, adjustment, score)

    return {
        "score": score,
        "signal": signal,
        "data_available": True,
        "current_8ma": current_8ma,
        "percentile_rank": percentile,
        "base_score": base_score,
        "adjustment": adjustment,
        "avg_peak": avg_peak,
        "avg_trough": avg_trough,
        "total_observations": len(all_8ma),
        "date": rows[-1]["Date"],
    }


def _score_percentile(percentile: float) -> int:
    """Score from percentile rank."""
    if percentile >= 80:
        return 90
    elif percentile >= 60:
        return 70
    elif percentile >= 40:
        return 50
    elif percentile >= 20:
        return 30
    else:
        return 10


def _safe_float(val: str) -> Optional[float]:
    """Safely parse float from string."""
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _generate_signal(percentile: float, adjustment: int, score: int) -> str:
    """Generate human-readable signal."""
    adj_str = ""
    if adjustment < 0:
        adj_str = " (near historical peak - overheated)"
    elif adjustment > 0:
        adj_str = " (near historical trough - oversold)"

    if score >= 70:
        return f"HIGH: {percentile:.0f}th percentile - above average breadth{adj_str}"
    elif score >= 40:
        return f"AVERAGE: {percentile:.0f}th percentile - normal range{adj_str}"
    else:
        return f"LOW: {percentile:.0f}th percentile - below average breadth{adj_str}"
