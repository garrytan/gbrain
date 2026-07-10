#!/usr/bin/env python3
"""
Component 4: Bearish Signal Status (Weight: 15%)

Evaluates the backtested bearish signal flag and its context.
Also detects the "Pink Zone" (Bearish Region) from the source repository:
  Pink Zone = Breadth_200MA_Trend == -1 AND 8MA < 200MA

Input: Bearish_Signal, Breadth_200MA_Trend, Breadth_Index_8MA,
       Breadth_Index_200MA (latest row)

Scoring (100 = healthy):
  Base:
    Signal=False & Trend=1  -> 85 (all clear)
    Signal=False & Trend=-1 -> 50 (no warning but downtrend)
    Signal=True  & Trend=1  -> 30 (warning in uptrend)
    Signal=True  & Trend=-1 -> 10 (fully bearish)

  Context Adjustment:
    Signal=True & 8MA > 0.50 -> +15 (weak signal amid strong breadth)
    Signal=True & 8MA < 0.25 -> -5  (severe signal amid extreme weakness)

  Pink Zone Adjustment:
    In Pink Zone & Signal=False -> -10 (structural weakness even without signal)
"""


def calculate_bearish_signal(rows: list[dict]) -> dict:
    """
    Calculate bearish signal status score.

    Args:
        rows: All detail rows sorted by date ascending.

    Returns:
        Dict with score, signal, and component details.
    """
    if not rows:
        return {
            "score": 50,
            "signal": "NO DATA: No data available for bearish signal analysis",
            "data_available": False,
        }

    latest = rows[-1]
    signal_active = latest["Bearish_Signal"]
    trend = latest["Breadth_200MA_Trend"]
    ma8 = latest["Breadth_Index_8MA"]
    ma200 = latest["Breadth_Index_200MA"]

    # Pink Zone detection (from source repo: chart's pink background)
    # Condition: 200MA trend declining AND 8MA below 200MA
    in_pink_zone = (trend == -1) and (ma8 < ma200)

    # Count consecutive pink zone days
    pink_zone_days = 0
    if in_pink_zone:
        for i in range(len(rows) - 1, -1, -1):
            r = rows[i]
            if r["Breadth_200MA_Trend"] == -1 and r["Breadth_Index_8MA"] < r["Breadth_Index_200MA"]:
                pink_zone_days += 1
            else:
                break

    # Base score
    base_score = _base_score(signal_active, trend)

    # Context adjustment
    context_adj = 0
    if signal_active:
        if ma8 > 0.50:
            context_adj = +15  # Weak signal amid strong breadth
        elif ma8 < 0.25:
            context_adj = -5  # Severe signal amid extreme weakness

    # Pink Zone adjustment: structural weakness even without bearish signal
    pink_zone_adj = 0
    if in_pink_zone and not signal_active:
        pink_zone_adj = -10

    score = round(base_score + context_adj + pink_zone_adj)
    score = max(0, min(100, score))

    signal_text = _generate_signal(signal_active, trend, ma8, in_pink_zone, score)

    return {
        "score": score,
        "signal": signal_text,
        "data_available": True,
        "signal_active": signal_active,
        "trend": trend,
        "current_8ma": ma8,
        "current_200ma": ma200,
        "in_pink_zone": in_pink_zone,
        "pink_zone_days": pink_zone_days,
        "base_score": base_score,
        "context_adjustment": context_adj,
        "pink_zone_adjustment": pink_zone_adj,
        "date": latest["Date"],
    }


def _base_score(signal_active: bool, trend: int) -> int:
    """Calculate base score from signal and trend combination."""
    if not signal_active and trend == 1:
        return 85  # All clear
    elif not signal_active and trend == -1:
        return 50  # No warning but downtrend
    elif signal_active and trend == 1:
        return 30  # Warning in uptrend
    else:  # signal_active and trend == -1
        return 10  # Fully bearish


def _generate_signal(
    signal_active: bool,
    trend: int,
    ma8: float,
    in_pink_zone: bool,
    score: int,
) -> str:
    """Generate human-readable signal."""
    trend_str = "uptrend" if trend == 1 else "downtrend"
    pink_str = " [PINK ZONE]" if in_pink_zone else ""

    if not signal_active:
        if trend == 1:
            return f"ALL CLEAR: No bearish signal, {trend_str}"
        elif in_pink_zone:
            return (
                f"CAUTION: No bearish signal but in Pink Zone (downtrend + 8MA < 200MA){pink_str}"
            )
        else:
            return f"CAUTION: No bearish signal but {trend_str}"
    else:
        if ma8 > 0.50:
            return (
                f"WARNING (muted): Bearish signal active in {trend_str}, "
                f"but 8MA={ma8:.3f} still relatively strong{pink_str}"
            )
        elif ma8 < 0.25:
            return (
                f"CRITICAL: Bearish signal active in {trend_str}, "
                f"8MA={ma8:.3f} extremely weak{pink_str}"
            )
        else:
            return f"BEARISH: Signal active in {trend_str}, 8MA={ma8:.3f}{pink_str}"
