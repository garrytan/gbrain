#!/usr/bin/env python3
"""
Component 2: 8MA vs 200MA Crossover Dynamics (Weight: 20%)

Detects momentum and direction changes via the gap between fast and slow MAs.

Input: Breadth_Index_8MA, Breadth_Index_200MA (latest + 5-day lookback)

Scoring (100 = healthy):
  Gap = 8MA - 200MA
    >= +0.15 -> 95    >= +0.10 -> 80    >= +0.05 -> 65
    >=  0.00 -> 50    >= -0.05 -> 35    >= -0.10 -> 20
    <  -0.10 -> 5

  Direction Modifier (5-day 8MA trend):
    Gap < 0 and 8MA rising  -> +10 (recovery signal)
    Gap > 0 and 8MA falling -> -10 (deterioration signal)
"""


def calculate_ma_crossover(rows: list[dict]) -> dict:
    """
    Calculate 8MA vs 200MA crossover dynamics score.

    Args:
        rows: All detail rows sorted by date ascending.

    Returns:
        Dict with score, signal, and component details.
    """
    if not rows or len(rows) < 6:
        return {
            "score": 50,
            "signal": "NO DATA: Insufficient data for crossover analysis",
            "data_available": False,
        }

    latest = rows[-1]
    ma8 = latest["Breadth_Index_8MA"]
    ma200 = latest["Breadth_Index_200MA"]
    gap = ma8 - ma200

    # Gap score
    gap_score = _score_gap(gap)

    # 8MA direction over last 5 days
    ma8_5d_ago = rows[-6]["Breadth_Index_8MA"]
    ma8_rising = ma8 > ma8_5d_ago
    ma8_direction = "rising" if ma8_rising else "falling"

    # Direction modifier
    direction_modifier = 0
    if gap < 0 and ma8_rising:
        direction_modifier = +10  # Recovery signal
    elif gap > 0 and not ma8_rising:
        direction_modifier = -10  # Deterioration signal

    score = round(gap_score + direction_modifier)
    score = max(0, min(100, score))

    signal = _generate_signal(gap, ma8_direction, direction_modifier, score)

    return {
        "score": score,
        "signal": signal,
        "data_available": True,
        "gap": gap,
        "gap_score": gap_score,
        "current_8ma": ma8,
        "current_200ma": ma200,
        "ma8_5d_ago": ma8_5d_ago,
        "ma8_direction": ma8_direction,
        "direction_modifier": direction_modifier,
        "date": latest["Date"],
    }


def _score_gap(gap: float) -> int:
    """Score based on 8MA - 200MA gap."""
    if gap >= 0.15:
        return 95
    elif gap >= 0.10:
        return 80
    elif gap >= 0.05:
        return 65
    elif gap >= 0.00:
        return 50
    elif gap >= -0.05:
        return 35
    elif gap >= -0.10:
        return 20
    else:
        return 5


def _generate_signal(gap: float, direction: str, modifier: int, score: int) -> str:
    """Generate human-readable signal."""
    mod_str = ""
    if modifier > 0:
        mod_str = " (recovery signal)"
    elif modifier < 0:
        mod_str = " (deterioration signal)"

    if score >= 80:
        return f"BULLISH: 8MA well above 200MA (gap={gap:+.3f}, 8MA {direction}){mod_str}"
    elif score >= 60:
        return f"POSITIVE: 8MA above 200MA (gap={gap:+.3f}, 8MA {direction}){mod_str}"
    elif score >= 40:
        return f"NEUTRAL: Near crossover (gap={gap:+.3f}, 8MA {direction}){mod_str}"
    elif score >= 20:
        return f"NEGATIVE: 8MA below 200MA (gap={gap:+.3f}, 8MA {direction}){mod_str}"
    else:
        return f"BEARISH: 8MA far below 200MA (gap={gap:+.3f}, 8MA {direction}){mod_str}"
