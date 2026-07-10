#!/usr/bin/env python3
"""
Component 3: Credit Conditions (Weight: 15%)

Analyzes HYG/LQD ratio to detect credit cycle transitions.

HYG (high-yield corporate bonds) / LQD (investment-grade corporate bonds):
- Rising ratio = credit risk appetite expanding, risk-on
- Falling ratio = flight to quality, credit tightening, risk-off

Transition signals:
- HYG/LQD turning up from bottom = credit cycle easing
- HYG/LQD turning down from top = credit cycle tightening
"""

from .utils import (
    calculate_ratio,
    compute_percentile,
    compute_roc,
    compute_sma,
    detect_crossover,
    determine_direction,
    downsample_to_monthly,
    score_transition_signal,
)


def calculate_credit_conditions(hyg_history: list[dict], lqd_history: list[dict]) -> dict:
    """
    Calculate credit conditions transition signal from HYG/LQD ratio.

    Args:
        hyg_history: HYG daily OHLCV (most recent first)
        lqd_history: LQD daily OHLCV (most recent first)

    Returns:
        Dict with score (0-100), signal, ratio details
    """
    if not hyg_history or not lqd_history:
        return _insufficient_data("No HYG or LQD data available")

    hyg_monthly = downsample_to_monthly(hyg_history)
    lqd_monthly = downsample_to_monthly(lqd_history)

    if len(hyg_monthly) < 12 or len(lqd_monthly) < 12:
        return _insufficient_data("Insufficient monthly data (need >= 12 months)")

    ratio_series = calculate_ratio(hyg_monthly, lqd_monthly)
    if len(ratio_series) < 12:
        return _insufficient_data("Insufficient ratio data")

    ratio_values = [r["value"] for r in ratio_series]
    current_ratio = ratio_values[0]
    current_date = ratio_series[0]["date"]

    sma_6m = compute_sma(ratio_values, 6)
    sma_12m = compute_sma(ratio_values, 12)
    crossover = detect_crossover(ratio_values, short_period=6, long_period=12)
    roc_3m = compute_roc(ratio_values, 3)
    roc_12m = compute_roc(ratio_values, 12)
    percentile = compute_percentile(ratio_values, current_ratio)

    score = score_transition_signal(
        crossover=crossover,
        roc_short=roc_3m,
        roc_long=roc_12m,
        sma_short=sma_6m,
        sma_long=sma_12m,
    )

    # Direction
    direction, momentum_qualifier = determine_direction(
        crossover,
        roc_3m,
        positive_label="easing",
        negative_label="tightening",
        neutral_label="stable",
    )

    signal = _describe_signal(score, direction, current_ratio)

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


def _describe_signal(score: int, direction: str, ratio: float) -> str:
    if score >= 60:
        return f"TRANSITION: Credit conditions {direction} (HYG/LQD={ratio:.4f})"
    elif score >= 40:
        return f"SHIFTING: Credit conditions {direction} (HYG/LQD={ratio:.4f})"
    else:
        return f"STABLE: Credit conditions stable (HYG/LQD={ratio:.4f})"


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
