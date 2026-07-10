#!/usr/bin/env python3
"""
Component 6: Sector Rotation (Weight: 10%)

Analyzes XLY/XLP ratio to detect cyclical vs defensive appetite.

XLY (Consumer Discretionary) / XLP (Consumer Staples):
- Rising ratio = risk appetite expanding, consumer confidence
- Falling ratio = defensive positioning, consumer caution

This is a classic risk-on/risk-off barometer that captures
consumer-facing economic sentiment.
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


def calculate_sector_rotation(xly_history: list[dict], xlp_history: list[dict]) -> dict:
    """
    Calculate sector rotation transition signal from XLY/XLP ratio.

    Args:
        xly_history: XLY daily OHLCV (most recent first)
        xlp_history: XLP daily OHLCV (most recent first)

    Returns:
        Dict with score (0-100), signal, ratio details
    """
    if not xly_history or not xlp_history:
        return _insufficient_data("No XLY or XLP data available")

    xly_monthly = downsample_to_monthly(xly_history)
    xlp_monthly = downsample_to_monthly(xlp_history)

    if len(xly_monthly) < 12 or len(xlp_monthly) < 12:
        return _insufficient_data("Insufficient monthly data (need >= 12 months)")

    ratio_series = calculate_ratio(xly_monthly, xlp_monthly)
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
        positive_label="risk_on",
        negative_label="risk_off",
        neutral_label="neutral",
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
        return f"TRANSITION: Sector rotation to {direction} (XLY/XLP={ratio:.4f})"
    elif score >= 40:
        return f"SHIFTING: Sector rotation trending {direction} (XLY/XLP={ratio:.4f})"
    else:
        return f"STABLE: Sector rotation stable, {direction} (XLY/XLP={ratio:.4f})"


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
