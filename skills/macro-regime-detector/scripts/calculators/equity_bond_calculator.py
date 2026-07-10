#!/usr/bin/env python3
"""
Component 5: Equity-Bond Relationship (Weight: 15%)

Analyzes SPY/TLT ratio and rolling stock-bond correlation to detect
changes in the equity-bond regime.

SPY/TLT ratio:
- Rising = equities outperforming bonds (risk-on)
- Falling = bonds outperforming equities (risk-off)

Stock-Bond Correlation:
- Negative correlation (normal): Bonds hedge equities
- Positive correlation (inflationary): Both move together, traditional hedging breaks
- Correlation sign change = major regime shift

Transition signals:
- SPY/TLT ratio crossover + correlation regime change = high confidence
"""

from typing import Optional

from .utils import (
    calculate_ratio,
    compute_percentile,
    compute_roc,
    compute_rolling_correlation,
    compute_sma,
    detect_crossover,
    determine_direction,
    downsample_to_monthly,
    score_transition_signal,
)


def calculate_equity_bond(spy_history: list[dict], tlt_history: list[dict]) -> dict:
    """
    Calculate equity-bond relationship transition signal.

    Args:
        spy_history: SPY daily OHLCV (most recent first)
        tlt_history: TLT daily OHLCV (most recent first)

    Returns:
        Dict with score (0-100), signal, ratio and correlation details
    """
    if not spy_history or not tlt_history:
        return _insufficient_data("No SPY or TLT data available")

    spy_monthly = downsample_to_monthly(spy_history)
    tlt_monthly = downsample_to_monthly(tlt_history)

    if len(spy_monthly) < 12 or len(tlt_monthly) < 12:
        return _insufficient_data("Insufficient monthly data (need >= 12 months)")

    # SPY/TLT ratio analysis
    ratio_series = calculate_ratio(spy_monthly, tlt_monthly)
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

    # Ratio transition score
    ratio_score = score_transition_signal(
        crossover=crossover,
        roc_short=roc_3m,
        roc_long=roc_12m,
        sma_short=sma_6m,
        sma_long=sma_12m,
    )

    # Rolling correlation analysis (monthly returns)
    spy_returns = _compute_monthly_returns([m["close"] for m in spy_monthly])
    tlt_returns = _compute_monthly_returns([m["close"] for m in tlt_monthly])

    correlation_6m = compute_rolling_correlation(spy_returns, tlt_returns, 6)
    correlation_12m = compute_rolling_correlation(spy_returns, tlt_returns, 12)

    # Correlation regime
    corr_regime = _classify_correlation_regime(correlation_6m, correlation_12m)

    # Correlation transition bonus (0-20)
    corr_bonus = 0
    if correlation_6m is not None and correlation_12m is not None:
        # Sign change between 6M and 12M correlation = regime transition
        if (correlation_6m > 0) != (correlation_12m > 0):
            corr_bonus = 20
        elif abs(correlation_6m - correlation_12m) > 0.3:
            corr_bonus = 10

    # Combined score
    score = min(100, ratio_score + corr_bonus)

    # Direction
    direction, momentum_qualifier = determine_direction(
        crossover,
        roc_3m,
        positive_label="risk_on",
        negative_label="risk_off",
        neutral_label="neutral",
    )

    signal = _describe_signal(score, direction, corr_regime, current_ratio)

    return {
        "score": score,
        "signal": signal,
        "data_available": True,
        "direction": direction,
        "momentum_qualifier": momentum_qualifier,
        "correlation_regime": corr_regime,
        "current_ratio": round(current_ratio, 4),
        "current_date": current_date,
        "sma_6m": round(sma_6m, 4) if sma_6m is not None else None,
        "sma_12m": round(sma_12m, 4) if sma_12m is not None else None,
        "roc_3m": round(roc_3m, 2) if roc_3m is not None else None,
        "roc_12m": round(roc_12m, 2) if roc_12m is not None else None,
        "percentile": round(percentile, 1) if percentile is not None else None,
        "correlation_6m": round(correlation_6m, 3) if correlation_6m is not None else None,
        "correlation_12m": round(correlation_12m, 3) if correlation_12m is not None else None,
        "crossover": crossover,
        "monthly_points": len(ratio_series),
    }


def _compute_monthly_returns(closes: list[float]) -> list[float]:
    """Compute month-over-month returns from closes (most recent first)."""
    if len(closes) < 2:
        return []
    returns = []
    for i in range(len(closes) - 1):
        if closes[i + 1] != 0:
            ret = (closes[i] - closes[i + 1]) / closes[i + 1]
            returns.append(ret)
    return returns


def _classify_correlation_regime(corr_6m: Optional[float], corr_12m: Optional[float]) -> str:
    """Classify the stock-bond correlation regime."""
    if corr_6m is None:
        return "unknown"

    if corr_6m < -0.3:
        return "negative_strong"  # Normal hedging
    elif corr_6m < 0:
        return "negative_mild"  # Weak hedging
    elif corr_6m < 0.3:
        return "near_zero"  # Transitional
    else:
        return "positive"  # Inflationary regime


def _describe_signal(score: int, direction: str, corr_regime: str, ratio: float) -> str:
    corr_labels = {
        "negative_strong": "strong negative correlation (normal hedging)",
        "negative_mild": "mild negative correlation",
        "near_zero": "near-zero correlation (transitional)",
        "positive": "positive correlation (inflationary)",
        "unknown": "unknown correlation",
    }
    corr_label = corr_labels.get(corr_regime, corr_regime)

    if score >= 60:
        return f"TRANSITION: Equity-bond shift to {direction}, {corr_label} (SPY/TLT={ratio:.4f})"
    elif score >= 40:
        return f"SHIFTING: Equity-bond trending {direction}, {corr_label} (SPY/TLT={ratio:.4f})"
    else:
        return f"STABLE: Equity-bond stable, {corr_label} (SPY/TLT={ratio:.4f})"


def _insufficient_data(reason: str) -> dict:
    return {
        "score": 0,
        "signal": f"INSUFFICIENT DATA: {reason}",
        "data_available": False,
        "direction": "unknown",
        "correlation_regime": "unknown",
        "current_ratio": None,
        "current_date": None,
        "sma_6m": None,
        "sma_12m": None,
        "roc_3m": None,
        "roc_12m": None,
        "percentile": None,
        "correlation_6m": None,
        "correlation_12m": None,
        "crossover": {"type": "none", "bars_ago": None},
        "monthly_points": 0,
    }
