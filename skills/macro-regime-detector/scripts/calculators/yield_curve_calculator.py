#!/usr/bin/env python3
"""
Component 2: Yield Curve (Weight: 20%)

Analyzes 10Y-2Y Treasury spread to detect interest rate cycle transitions.

Primary data: Treasury API (10Y-2Y spread directly)
Fallback: SHY/TLT ratio as proxy for yield curve shape

Transition signals:
- Inversion → Normalization: Often precedes recession end, risk-on shift
- Steepening from flat: Economic recovery signal
- Flattening from steep: Late-cycle tightening signal
- Deep inversion: Recession warning

Scoring (0-100 = Transition Signal Strength):
  0-20:  Stable yield curve regime
  20-40: Minor changes in spread
  40-60: Transition zone (curve shape changing)
  60-80: Clear transition (inversion/normalization crossover)
  80-100: Strong confirmed transition
"""

from typing import Optional

from .utils import (
    calculate_ratio,
    compute_percentile,
    compute_roc,
    compute_sma,
    detect_crossover,
    downsample_to_monthly,
    score_transition_signal,
)


def calculate_yield_curve(
    treasury_rates: Optional[list[dict]] = None,
    shy_history: Optional[list[dict]] = None,
    tlt_history: Optional[list[dict]] = None,
) -> dict:
    """
    Calculate yield curve transition signal.

    Args:
        treasury_rates: Treasury rate data from FMP stable API (most recent first)
        shy_history: SHY daily OHLCV (fallback, most recent first)
        tlt_history: TLT daily OHLCV (fallback, most recent first)

    Returns:
        Dict with score, signal, spread details, curve state
    """
    # Try Treasury API first
    if treasury_rates:
        result = _analyze_treasury_spread(treasury_rates)
        if result is not None:
            return result

    # Fallback to SHY/TLT ratio
    if shy_history and tlt_history:
        return _analyze_shy_tlt_proxy(shy_history, tlt_history)

    return _insufficient_data("No treasury rates or SHY/TLT data available")


def _analyze_treasury_spread(treasury_rates: list[dict]) -> Optional[dict]:
    """Analyze 10Y-2Y spread from Treasury API data."""
    # Extract 10Y-2Y spread series
    spread_monthly = {}
    for entry in treasury_rates:
        date_str = entry.get("date", "")
        year10 = entry.get("year10")
        year2 = entry.get("year2")

        if not date_str or year10 is None or year2 is None:
            continue

        try:
            y10 = float(year10)
            y2 = float(year2)
        except (ValueError, TypeError):
            continue

        ym = date_str[:7]
        if ym not in spread_monthly:
            spread_monthly[ym] = {
                "date": date_str,
                "spread": y10 - y2,
                "year10": y10,
                "year2": y2,
            }

    if len(spread_monthly) < 12:
        return None

    # Sort most recent first
    spread_series = sorted(spread_monthly.values(), key=lambda x: x["date"], reverse=True)
    spread_values = [s["spread"] for s in spread_series]

    current_spread = spread_values[0]
    current_date = spread_series[0]["date"]
    current_10y = spread_series[0]["year10"]
    current_2y = spread_series[0]["year2"]

    # Compute SMAs
    sma_6m = compute_sma(spread_values, 6)
    sma_12m = compute_sma(spread_values, 12)

    # Crossover detection
    crossover = detect_crossover(spread_values, short_period=6, long_period=12)

    # Individual yield ROCs for steepening type classification
    y10_values = [s["year10"] for s in spread_series]
    y2_values = [s["year2"] for s in spread_series]
    roc_3m_10y = compute_roc(y10_values, 3)
    roc_3m_2y = compute_roc(y2_values, 3)

    # Momentum
    roc_3m = compute_roc(spread_values, 3)
    roc_12m = compute_roc(spread_values, 12)

    # Percentile
    percentile = compute_percentile(spread_values, current_spread)

    # Score
    score = score_transition_signal(
        crossover=crossover,
        roc_short=roc_3m,
        roc_long=roc_12m,
        sma_short=sma_6m,
        sma_long=sma_12m,
    )

    # Curve state
    curve_state = _classify_curve_state(current_spread, sma_6m, roc_3m)

    # Direction of transition
    if roc_3m is not None and roc_3m > 0:
        direction = "steepening"
    elif roc_3m is not None and roc_3m < 0:
        direction = "flattening"
    else:
        direction = "stable"

    # Steepening type classification
    steepening_type = None
    if direction == "steepening":
        if roc_3m_2y is not None and roc_3m_2y < 0:
            steepening_type = "bull_steepener"
        elif roc_3m_10y is not None and roc_3m_10y > 0:
            steepening_type = "bear_steepener"
        else:
            steepening_type = "mixed_steepener"

    signal = _describe_signal(score, curve_state, current_spread, direction)

    return {
        "score": score,
        "signal": signal,
        "data_available": True,
        "data_source": "treasury_api",
        "direction": direction,
        "curve_state": curve_state,
        "steepening_type": steepening_type,
        "current_spread": round(current_spread, 3),
        "current_10y": current_10y,
        "current_2y": current_2y,
        "current_date": current_date,
        "sma_6m": round(sma_6m, 3) if sma_6m is not None else None,
        "sma_12m": round(sma_12m, 3) if sma_12m is not None else None,
        "roc_3m": round(roc_3m, 2) if roc_3m is not None else None,
        "roc_12m": round(roc_12m, 2) if roc_12m is not None else None,
        "roc_3m_10y": round(roc_3m_10y, 2) if roc_3m_10y is not None else None,
        "roc_3m_2y": round(roc_3m_2y, 2) if roc_3m_2y is not None else None,
        "percentile": round(percentile, 1) if percentile is not None else None,
        "crossover": crossover,
        "monthly_points": len(spread_series),
    }


def _analyze_shy_tlt_proxy(shy_history: list[dict], tlt_history: list[dict]) -> dict:
    """Fallback: Use SHY/TLT ratio as yield curve proxy."""
    shy_monthly = downsample_to_monthly(shy_history)
    tlt_monthly = downsample_to_monthly(tlt_history)

    if len(shy_monthly) < 12 or len(tlt_monthly) < 12:
        return _insufficient_data("Insufficient SHY/TLT monthly data")

    # SHY/TLT ratio: rising = curve flattening/inverting, falling = steepening
    ratio_series = calculate_ratio(shy_monthly, tlt_monthly)
    if len(ratio_series) < 12:
        return _insufficient_data("Insufficient SHY/TLT ratio data")

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

    # For SHY/TLT: rising ratio = flattening, falling = steepening
    if roc_3m is not None and roc_3m < 0:
        direction = "steepening"
    elif roc_3m is not None and roc_3m > 0:
        direction = "flattening"
    else:
        direction = "stable"

    signal = f"PROXY (SHY/TLT): {direction} signal, score={score}"

    return {
        "score": score,
        "signal": signal,
        "data_available": True,
        "data_source": "shy_tlt_proxy",
        "direction": direction,
        "curve_state": "proxy_only",
        "steepening_type": None,
        "current_spread": None,
        "current_10y": None,
        "current_2y": None,
        "current_date": current_date,
        "proxy_ratio": round(current_ratio, 4),
        "sma_6m": round(sma_6m, 4) if sma_6m is not None else None,
        "sma_12m": round(sma_12m, 4) if sma_12m is not None else None,
        "roc_3m": round(roc_3m, 2) if roc_3m is not None else None,
        "roc_12m": round(roc_12m, 2) if roc_12m is not None else None,
        "percentile": round(percentile, 1) if percentile is not None else None,
        "crossover": crossover,
        "monthly_points": len(ratio_series),
    }


def _classify_curve_state(spread: float, sma_6m: Optional[float], roc_3m: Optional[float]) -> str:
    """Classify current yield curve state."""
    if spread < -0.5:
        return "deeply_inverted"
    elif spread < 0:
        return "inverted"
    elif spread < 0.5:
        if roc_3m is not None and roc_3m > 0:
            return "normalizing"
        return "flat"
    elif spread < 1.5:
        return "normal"
    else:
        return "steep"


def _describe_signal(score: int, state: str, spread: float, direction: str) -> str:
    state_labels = {
        "deeply_inverted": "Deeply Inverted",
        "inverted": "Inverted",
        "normalizing": "Normalizing",
        "flat": "Flat",
        "normal": "Normal",
        "steep": "Steep",
    }
    state_label = state_labels.get(state, state)

    if score >= 60:
        return f"TRANSITION: Yield curve {direction} ({state_label}, spread={spread:+.3f}%)"
    elif score >= 40:
        return f"SHIFTING: Yield curve {direction} ({state_label}, spread={spread:+.3f}%)"
    else:
        return f"STABLE: Yield curve {state_label} (spread={spread:+.3f}%)"


def _insufficient_data(reason: str) -> dict:
    return {
        "score": 0,
        "signal": f"INSUFFICIENT DATA: {reason}",
        "data_available": False,
        "data_source": "none",
        "direction": "unknown",
        "curve_state": "unknown",
        "current_spread": None,
        "current_10y": None,
        "current_2y": None,
        "current_date": None,
        "sma_6m": None,
        "sma_12m": None,
        "roc_3m": None,
        "roc_12m": None,
        "percentile": None,
        "crossover": {"type": "none", "bars_ago": None},
        "monthly_points": 0,
    }
