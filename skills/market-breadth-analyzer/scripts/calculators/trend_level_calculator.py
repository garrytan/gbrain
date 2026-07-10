#!/usr/bin/env python3
"""
Component 1: Current Breadth Level & Trend (Weight: 25%)

The most direct indicator of market health.

Input: Breadth_Index_8MA, Breadth_200MA_Trend (latest row + 5-day lookback)

Scoring (100 = healthy):
  8MA Level (70% of component):
    >= 0.70 -> 95    >= 0.60 -> 80    >= 0.50 -> 65
    >= 0.40 -> 50    >= 0.30 -> 35    >= 0.20 -> 20
    <  0.20 -> 5

  200MA Trend (30% of component):
    Trend == 1  -> 80 (uptrend)
    Trend == -1 -> 20 (downtrend)

  8MA Direction Modifier (5-day direction):
    Falling & level > 0.60 -> -10 (deceleration from high level)
    Falling & level < 0.40 -> +5  (limited downside near bottom)
    Rising  & level < 0.60 -> +5  (early recovery bonus)
    Otherwise              ->  0

  Score = clamp(0.70 * level_score + 0.30 * trend_score + modifier, 0, 100)
"""


def calculate_breadth_level_trend(rows: list[dict]) -> dict:
    """
    Calculate current breadth level and trend score.

    Args:
        rows: All detail rows sorted by date ascending.

    Returns:
        Dict with score, signal, and component details.
    """
    if not rows:
        return {
            "score": 50,
            "signal": "NO DATA: No breadth data available",
            "data_available": False,
        }

    latest = rows[-1]
    ma8 = latest["Breadth_Index_8MA"]
    trend = latest["Breadth_200MA_Trend"]

    # 8MA level score
    level_score = _score_8ma_level(ma8)

    # Trend score
    trend_score = 80 if trend == 1 else 20

    # 8MA direction modifier
    ma8_direction, direction_modifier = _direction_modifier(rows, ma8)

    # Combined
    base = round(0.70 * level_score + 0.30 * trend_score)
    score = max(0, min(100, base + direction_modifier))

    # Signal
    signal = _generate_signal(ma8, trend, score)

    result = {
        "score": score,
        "signal": signal,
        "data_available": True,
        "current_8ma": ma8,
        "current_200ma": latest["Breadth_Index_200MA"],
        "trend": trend,
        "level_score": level_score,
        "trend_score": trend_score,
        "date": latest["Date"],
    }

    if ma8_direction is not None:
        result["ma8_direction"] = ma8_direction
        result["direction_modifier"] = direction_modifier

    return result


def _direction_modifier(rows: list[dict], current_8ma: float):
    """Calculate 8MA direction modifier based on 5-day movement.

    Returns (direction_str_or_None, modifier_int).
    """
    if len(rows) < 6:
        return None, 0

    ma8_5d_ago = rows[-6]["Breadth_Index_8MA"]

    if current_8ma > ma8_5d_ago:
        direction = "rising"
    elif current_8ma < ma8_5d_ago:
        direction = "falling"
    else:
        return "flat", 0

    if direction == "falling" and current_8ma > 0.60:
        return direction, -10
    if direction == "falling" and current_8ma < 0.40:
        return direction, 5
    if direction == "rising" and current_8ma < 0.60:
        return direction, 5

    return direction, 0


def _score_8ma_level(ma8: float) -> int:
    """Score based on 8MA level."""
    if ma8 >= 0.70:
        return 95
    elif ma8 >= 0.60:
        return 80
    elif ma8 >= 0.50:
        return 65
    elif ma8 >= 0.40:
        return 50
    elif ma8 >= 0.30:
        return 35
    elif ma8 >= 0.20:
        return 20
    else:
        return 5


def _generate_signal(ma8: float, trend: int, score: int) -> str:
    """Generate human-readable signal."""
    trend_str = "uptrend" if trend == 1 else "downtrend"

    if score >= 80:
        return f"STRONG: 8MA={ma8:.3f} in {trend_str} - broad participation"
    elif score >= 60:
        return f"HEALTHY: 8MA={ma8:.3f} in {trend_str} - above average"
    elif score >= 40:
        return f"NEUTRAL: 8MA={ma8:.3f} in {trend_str} - mixed signals"
    elif score >= 20:
        return f"WEAK: 8MA={ma8:.3f} in {trend_str} - deteriorating breadth"
    else:
        return f"CRITICAL: 8MA={ma8:.3f} in {trend_str} - severe weakness"
