#!/usr/bin/env python3
"""
Component 6: S&P 500 vs Breadth Divergence (Weight: 10%)

Detects divergence between price action and breadth participation.

Uses dual windows:
  - 60-day window (weight 0.6): Medium-term structural divergence
  - 20-day window (weight 0.4): Short-term early warning

Composite score = 60d_score * 0.6 + 20d_score * 0.4

Early Warning: 20d bearish (<=25) while 60d healthy (>=50) flags
an emerging short-term divergence before it becomes structural.

Input: S&P500_Price, Breadth_Index_8MA (last 60+ days)

Scoring per window (100 = healthy):
  Both rising                        -> 70 (healthy rally)
  Both falling                       -> 30 (consistent decline)
  SP up(>3%) & Breadth down(<-0.05)  -> 10 (dangerous divergence)
  SP up(>1%) & Breadth down(<-0.03)  -> 25
  SP down(<-3%) & Breadth up(>+0.05) -> 80 (bullish divergence)
  SP down(<-1%) & Breadth up(>+0.03) -> 65
  Otherwise                          -> 50
"""


def calculate_divergence(rows: list[dict]) -> dict:
    """
    Calculate S&P 500 vs breadth divergence score using dual windows.

    Args:
        rows: All detail rows sorted by date ascending.

    Returns:
        Dict with score, signal, windows, and component details.
    """
    if not rows or len(rows) < 20:
        return {
            "score": 50,
            "signal": "NO DATA: Insufficient data for divergence analysis",
            "data_available": False,
        }

    latest = rows[-1]

    # Compute both windows
    w60 = _compute_window(rows, 60)
    w20 = _compute_window(rows, 20)

    # Composite score
    score = round(w60["score"] * 0.6 + w20["score"] * 0.4, 1)
    score = max(0, min(100, score))

    # Early Warning: short-term bearish divergence while long-term healthy
    early_warning = w20["score"] <= 25 and w60["score"] >= 50

    # Signal uses the composite
    signal = _generate_signal(w60["sp_pct"], w60["breadth_chg"], w60["div_type"], score)

    return {
        "score": score,
        "signal": signal,
        "data_available": True,
        # Top-level backward compatibility (from 60d window)
        "sp500_pct_change": round(w60["sp_pct"], 2),
        "breadth_change": round(w60["breadth_chg"], 4),
        "sp500_latest": latest["S&P500_Price"],
        "sp500_past": w60["sp_past"],
        "ma8_latest": latest["Breadth_Index_8MA"],
        "ma8_past": w60["ma8_past"],
        "lookback_days": w60["lookback_days"],
        "divergence_type": w60["div_type"],
        "date": latest["Date"],
        # New window details
        "window_60d": {
            "score": w60["score"],
            "divergence_type": w60["div_type"],
            "sp500_pct_change": round(w60["sp_pct"], 2),
            "breadth_change": round(w60["breadth_chg"], 4),
            "lookback_days": w60["lookback_days"],
        },
        "window_20d": {
            "score": w20["score"],
            "divergence_type": w20["div_type"],
            "sp500_pct_change": round(w20["sp_pct"], 2),
            "breadth_change": round(w20["breadth_chg"], 4),
            "lookback_days": w20["lookback_days"],
        },
        "early_warning": early_warning,
    }


def _compute_window(rows: list[dict], lookback: int) -> dict:
    """Compute divergence metrics for a single lookback window."""
    actual_lookback = min(lookback, len(rows))
    latest = rows[-1]
    past = rows[-actual_lookback]

    sp_latest = latest["S&P500_Price"]
    sp_past = past["S&P500_Price"]
    ma8_latest = latest["Breadth_Index_8MA"]
    ma8_past = past["Breadth_Index_8MA"]

    if sp_past <= 0:
        return {
            "score": 50,
            "sp_pct": 0.0,
            "breadth_chg": 0.0,
            "div_type": "Invalid data",
            "sp_past": sp_past,
            "ma8_past": ma8_past,
            "lookback_days": actual_lookback,
        }

    sp_pct = (sp_latest - sp_past) / sp_past * 100
    breadth_chg = ma8_latest - ma8_past

    score, div_type = _score_divergence(sp_pct, breadth_chg)
    score = max(0, min(100, score))

    return {
        "score": score,
        "sp_pct": sp_pct,
        "breadth_chg": breadth_chg,
        "div_type": div_type,
        "sp_past": sp_past,
        "ma8_past": ma8_past,
        "lookback_days": actual_lookback,
    }


def _score_divergence(sp_pct: float, breadth_chg: float) -> tuple[int, str]:
    """Score based on price/breadth divergence. Returns (score, type_label)."""
    sp_up = sp_pct > 0
    breadth_up = breadth_chg > 0

    # Dangerous divergence: SP up, breadth down
    if sp_pct > 3.0 and breadth_chg < -0.05:
        return 10, "Dangerous bearish divergence"
    if sp_pct > 1.0 and breadth_chg < -0.03:
        return 25, "Moderate bearish divergence"

    # Bullish divergence: SP down, breadth up
    if sp_pct < -3.0 and breadth_chg > 0.05:
        return 80, "Strong bullish divergence"
    if sp_pct < -1.0 and breadth_chg > 0.03:
        return 65, "Moderate bullish divergence"

    # Near-flat movements (noise level)
    if abs(sp_pct) < 0.5 and abs(breadth_chg) < 0.01:
        return 50, "Near-flat (insufficient movement)"

    # Aligned movements
    if sp_up and breadth_up:
        return 70, "Healthy alignment (both rising)"
    if not sp_up and not breadth_up:
        return 30, "Consistent decline (both falling)"

    return 50, "Mixed signals"


def _generate_signal(sp_pct: float, breadth_chg: float, div_type: str, score: int) -> str:
    """Generate human-readable signal."""
    return f"{div_type}: S&P {sp_pct:+.1f}%, Breadth 8MA {breadth_chg:+.3f} over 60d"
