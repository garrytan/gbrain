#!/usr/bin/env python3
"""
Component 3: Peak/Trough Cycle Position (Weight: 20%)

Determines where we are in the breadth cycle relative to recent peaks and troughs.

Input: Is_Peak, Is_Trough, Is_Trough_8MA_Below_04, Breadth_Index_8MA (last 120 days)

Scoring (100 = healthy):
  Latest marker = TROUGH:
    <= 20 days & 8MA rising       -> 85 (early recovery)
    <= 20 days & 8MA flat/falling -> 30 (failed reversal)
    21-60 days & 8MA rising       -> 75 (sustained recovery)
    > 60 days & 8MA rising        -> 65 (mature recovery)

  Latest marker = PEAK:
    <= 20 days & 8MA falling      -> 20 (post-peak decline)
    <= 20 days & 8MA flat/rising  -> 60 (high-level consolidation)
    21-60 days & 8MA falling      -> 15 (sustained decline)
    > 60 days & 8MA falling       -> 10 (prolonged decline)
    > 60 days & 8MA rising        -> 50 (possible bottom formation)

  Extreme Trough Bonus: Is_Trough_8MA_Below_04 == True -> +10
  No marker within 120 days -> 50 (neutral)
"""

from typing import Optional


def calculate_cycle_position(rows: list[dict]) -> dict:
    """
    Calculate peak/trough cycle position score.

    Args:
        rows: All detail rows sorted by date ascending.

    Returns:
        Dict with score, signal, and component details.
    """
    if not rows or len(rows) < 10:
        return {
            "score": 50,
            "signal": "NO DATA: Insufficient data for cycle analysis",
            "data_available": False,
        }

    # Look at last 120 trading days
    lookback = min(120, len(rows))
    recent = rows[-lookback:]
    latest = rows[-1]
    current_8ma = latest["Breadth_Index_8MA"]

    # Find latest peak or trough marker
    marker_type, marker_idx, days_since = _find_latest_marker(recent)

    # Determine 8MA trend (rising/falling) over last 5 days
    if len(rows) >= 6:
        ma8_trend = "rising" if current_8ma > rows[-6]["Breadth_Index_8MA"] else "falling"
    else:
        ma8_trend = "unknown"

    # Check for extreme trough
    extreme_trough = False
    if marker_type == "TROUGH":
        extreme_trough = recent[marker_idx]["Is_Trough_8MA_Below_04"]

    # Calculate score
    score = _calculate_score(marker_type, days_since, ma8_trend, extreme_trough)
    score = max(0, min(100, score))

    signal = _generate_signal(marker_type, days_since, ma8_trend, score)

    marker_found = marker_type is not None

    return {
        "score": score,
        "signal": signal,
        "data_available": marker_found,
        "latest_marker_type": marker_type,
        "days_since_marker": days_since,
        "ma8_trend": ma8_trend,
        "current_8ma": current_8ma,
        "extreme_trough": extreme_trough,
        "date": latest["Date"],
    }


def _find_latest_marker(recent: list[dict]) -> tuple[Optional[str], int, Optional[int]]:
    """
    Find the most recent peak or trough marker.

    Returns (marker_type, index_in_recent, days_since).
    """
    for i in range(len(recent) - 1, -1, -1):
        row = recent[i]
        if row["Is_Peak"]:
            days_since = len(recent) - 1 - i
            return "PEAK", i, days_since
        if row["Is_Trough"] or row["Is_Trough_8MA_Below_04"]:
            days_since = len(recent) - 1 - i
            return "TROUGH", i, days_since

    return None, -1, None


def _calculate_score(
    marker_type: Optional[str],
    days_since: Optional[int],
    ma8_trend: str,
    extreme_trough: bool,
) -> int:
    """Calculate cycle position score based on marker and context."""
    if marker_type is None or days_since is None:
        return 50  # Neutral when no marker found

    rising = ma8_trend == "rising"

    if marker_type == "TROUGH":
        if days_since <= 20:
            base = 85 if rising else 30
        elif days_since <= 60:
            base = 75 if rising else 35
        else:
            base = 65 if rising else 40

        # Extreme trough bonus (contrarian buy signal)
        if extreme_trough:
            base += 10

    elif marker_type == "PEAK":
        if days_since <= 20:
            base = 60 if rising else 20
        elif days_since <= 60:
            base = 45 if rising else 15
        else:
            base = 50 if rising else 10

    else:
        base = 50

    return base


def _generate_signal(
    marker_type: Optional[str],
    days_since: Optional[int],
    ma8_trend: str,
    score: int,
) -> str:
    """Generate human-readable signal."""
    if marker_type is None:
        return "NEUTRAL: No cycle marker in last 120 days"

    if marker_type == "TROUGH":
        if days_since <= 20:
            phase = "early recovery" if ma8_trend == "rising" else "failed reversal attempt"
        elif days_since <= 60:
            phase = "sustained recovery" if ma8_trend == "rising" else "stalled recovery"
        else:
            phase = "mature recovery" if ma8_trend == "rising" else "weakening recovery"
        return f"TROUGH ({days_since}d ago): {phase}, 8MA {ma8_trend}"

    else:  # PEAK
        if days_since <= 20:
            phase = "consolidation near highs" if ma8_trend == "rising" else "post-peak decline"
        elif days_since <= 60:
            phase = "gradual decline" if ma8_trend != "rising" else "recovery attempt"
        else:
            phase = "possible bottom formation" if ma8_trend == "rising" else "prolonged decline"
        return f"PEAK ({days_since}d ago): {phase}, 8MA {ma8_trend}"
