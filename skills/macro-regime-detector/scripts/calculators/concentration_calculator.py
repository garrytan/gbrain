#!/usr/bin/env python3
"""
Component 1: Market Concentration (Weight: 25%)

Analyzes RSP/SPY ratio to detect mega-cap concentration vs market broadening.

RSP (equal-weight S&P 500) / SPY (cap-weight S&P 500):
- Declining ratio = increasing concentration in mega-caps
- Rising ratio = market broadening, more stocks participating

Scoring (0-100 = Transition Signal Strength):
  0-20:  Stable regime, no transition signal
  20-40: Minor fluctuation, possibly noise
  40-60: Transition zone (MAs converging, crossover possible in 3-6 months)
  60-80: Clear transition signal (recent crossover or sharp momentum reversal)
  80-100: Strong confirmed transition (crossover + momentum + acceleration aligned)
"""

from typing import Optional

from .utils import (
    STALE_CROSSOVER_MONTHS,
    calculate_ratio,
    compute_percentile,
    compute_roc,
    compute_sma,
    detect_crossover,
    downsample_to_monthly,
    score_transition_signal,
)


def calculate_concentration(rsp_history: list[dict], spy_history: list[dict]) -> dict:
    """
    Calculate market concentration transition signal from RSP/SPY ratio.

    Args:
        rsp_history: RSP daily OHLCV (most recent first)
        spy_history: SPY daily OHLCV (most recent first)

    Returns:
        Dict with score (0-100), signal, ratio details, MA values, momentum
    """
    if not rsp_history or not spy_history:
        return _insufficient_data("No RSP or SPY data available")

    # Downsample to monthly
    rsp_monthly = downsample_to_monthly(rsp_history)
    spy_monthly = downsample_to_monthly(spy_history)

    if len(rsp_monthly) < 12 or len(spy_monthly) < 12:
        return _insufficient_data("Insufficient monthly data (need >= 12 months)")

    # Calculate RSP/SPY ratio (monthly)
    ratio_series = calculate_ratio(rsp_monthly, spy_monthly)
    if len(ratio_series) < 12:
        return _insufficient_data("Insufficient ratio data")

    # Current ratio
    current_ratio = ratio_series[0]["value"]
    current_date = ratio_series[0]["date"]

    # Compute 6M and 12M SMAs on ratio
    ratio_values = [r["value"] for r in ratio_series]
    sma_6m = compute_sma(ratio_values, 6)
    sma_12m = compute_sma(ratio_values, 12)

    # Crossover detection (6M vs 12M)
    crossover = detect_crossover(ratio_values, short_period=6, long_period=12)

    # Momentum: 3-month and 12-month ROC
    roc_3m = compute_roc(ratio_values, 3)
    roc_12m = compute_roc(ratio_values, 12)

    # Percentile of current ratio within historical range
    percentile = compute_percentile(ratio_values, current_ratio)

    # Score the transition signal
    score = score_transition_signal(
        crossover=crossover,
        roc_short=roc_3m,
        roc_long=roc_12m,
        sma_short=sma_6m,
        sma_long=sma_12m,
    )

    # Determine signal description
    signal = _describe_signal(score, crossover, roc_3m, roc_12m, current_ratio)

    # Determine direction (concentration-specific: SMA fallback preserved)
    bars_ago = crossover.get("bars_ago")
    is_stale = bars_ago is not None and bars_ago >= STALE_CROSSOVER_MONTHS

    if crossover["type"] == "golden_cross":
        direction = "broadening"
    elif crossover["type"] == "death_cross":
        direction = "concentrating"
    elif sma_6m is not None and sma_12m is not None:
        direction = "broadening" if sma_6m > sma_12m else "concentrating"
    else:
        direction = "unknown"

    # Stale crossover override: if momentum contradicts, flip direction
    momentum_qualifier = "N/A"
    if crossover["type"] in ("golden_cross", "death_cross"):
        cross_dir = "broadening" if crossover["type"] == "golden_cross" else "concentrating"
        mom_dir = (
            "broadening"
            if roc_3m is not None and roc_3m > 0
            else "concentrating"
            if roc_3m is not None and roc_3m < 0
            else None
        )
        if is_stale and mom_dir and mom_dir != cross_dir:
            direction = mom_dir
            momentum_qualifier = "reversing"
        elif mom_dir == cross_dir:
            momentum_qualifier = "confirmed"
        elif mom_dir and mom_dir != cross_dir:
            momentum_qualifier = "fading"

    return {
        "score": score,
        "signal": signal,
        "data_available": True,
        "direction": direction,
        "momentum_qualifier": momentum_qualifier,
        "current_ratio": round(current_ratio, 4),
        "current_date": current_date,
        "sma_6m": round(sma_6m, 4) if sma_6m is not None else None,
        "sma_12m": round(sma_12m, 4) if sma_12m is not None else None,
        "roc_3m": round(roc_3m, 2) if roc_3m is not None else None,
        "roc_12m": round(roc_12m, 2) if roc_12m is not None else None,
        "percentile": round(percentile, 1) if percentile is not None else None,
        "crossover": crossover,
        "monthly_points": len(ratio_series),
    }


def _describe_signal(
    score: int, crossover: dict, roc_3m: Optional[float], roc_12m: Optional[float], ratio: float
) -> str:
    if score >= 80:
        return f"STRONG TRANSITION: RSP/SPY {crossover['type'].replace('_', ' ')} confirmed with aligned momentum"
    elif score >= 60:
        return "TRANSITION SIGNAL: RSP/SPY crossover or sharp momentum reversal detected"
    elif score >= 40:
        return "TRANSITION ZONE: RSP/SPY MAs converging, potential crossover ahead"
    elif score >= 20:
        return f"MINOR SHIFT: RSP/SPY ratio showing slight change ({ratio:.4f})"
    else:
        return f"STABLE: RSP/SPY ratio in established trend ({ratio:.4f})"


def _insufficient_data(reason: str) -> dict:
    return {
        "score": 0,
        "signal": f"INSUFFICIENT DATA: {reason}",
        "data_available": False,
        "direction": "unknown",
        "current_ratio": None,
        "current_date": None,
        "sma_6m": None,
        "sma_12m": None,
        "roc_3m": None,
        "roc_12m": None,
        "percentile": None,
        "crossover": {"type": "none", "bars_ago": None},
        "monthly_points": 0,
    }
