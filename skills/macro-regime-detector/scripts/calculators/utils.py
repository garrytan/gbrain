#!/usr/bin/env python3
"""
Shared utility functions for macro regime calculators.

Provides monthly downsampling, ratio calculation, moving averages,
crossover detection, momentum computation, and transition scoring.
"""

from typing import Optional


def downsample_to_monthly(daily_history: list[dict]) -> list[dict]:
    """
    Downsample daily OHLCV to monthly (last business day of each month).

    Args:
        daily_history: Daily bars, most recent first.

    Returns:
        List of monthly bars (most recent first), each with 'date', 'close'.
    """
    if not daily_history:
        return []

    # Group by year-month, pick the most recent bar per month
    monthly = {}
    for bar in daily_history:
        date_str = bar.get("date", "")
        close = bar.get("adjClose", bar.get("close", 0))
        if not date_str or close == 0:
            continue

        # Extract year-month key
        ym = date_str[:7]  # "YYYY-MM"
        if ym not in monthly:
            monthly[ym] = {"date": date_str, "close": close}
        else:
            # daily_history is most recent first, so first occurrence is the latest in that month
            # Keep the first (most recent) bar for each month
            pass

    # Sort by date descending (most recent first)
    result = sorted(monthly.values(), key=lambda x: x["date"], reverse=True)
    return result


def calculate_ratio(numerator_monthly: list[dict], denominator_monthly: list[dict]) -> list[dict]:
    """
    Calculate ratio of two monthly series aligned by date.

    Args:
        numerator_monthly: Monthly bars for numerator (most recent first)
        denominator_monthly: Monthly bars for denominator (most recent first)

    Returns:
        List of {'date': str, 'value': float} (most recent first)
    """
    # Build lookup by year-month
    denom_lookup = {}
    for bar in denominator_monthly:
        ym = bar["date"][:7]
        denom_lookup[ym] = bar["close"]

    result = []
    for bar in numerator_monthly:
        ym = bar["date"][:7]
        if ym in denom_lookup and denom_lookup[ym] != 0:
            ratio = bar["close"] / denom_lookup[ym]
            result.append({"date": bar["date"], "value": ratio})

    return result


def compute_sma(values: list[float], period: int) -> Optional[float]:
    """
    Compute Simple Moving Average from a list of values (most recent first).

    Returns SMA of the most recent `period` values, or None if insufficient data.
    """
    if len(values) < period:
        return None
    return sum(values[:period]) / period


def detect_crossover(values: list[float], short_period: int = 6, long_period: int = 12) -> dict:
    """
    Detect SMA crossover between short and long periods.

    Args:
        values: Series of values (most recent first)
        short_period: Short-term SMA period (default 6)
        long_period: Long-term SMA period (default 12)

    Returns:
        Dict with 'type' ('golden_cross', 'death_cross', 'converging', 'none'),
        'bars_ago' (how many months ago the crossover occurred),
        'gap_pct' (current gap between short and long SMA as %)
    """
    if len(values) < long_period + 3:
        return {"type": "none", "bars_ago": None, "gap_pct": None}

    # Compute SMAs at each point
    max_lookback = min(len(values), long_period + 12)  # Check up to 12 months back
    sma_pairs = []
    for offset in range(max_lookback - long_period + 1):
        subset = values[offset:]
        short_sma = compute_sma(subset, short_period)
        long_sma = compute_sma(subset, long_period)
        if short_sma is not None and long_sma is not None:
            sma_pairs.append((short_sma, long_sma))

    if len(sma_pairs) < 2:
        return {"type": "none", "bars_ago": None, "gap_pct": None}

    # Current gap
    current_short, current_long = sma_pairs[0]
    if current_long != 0:
        gap_pct = (current_short - current_long) / current_long * 100
    else:
        gap_pct = 0

    # Look for crossover
    for i in range(1, len(sma_pairs)):
        prev_short, prev_long = sma_pairs[i]
        curr_short, curr_long = sma_pairs[i - 1]

        # Golden cross: short crosses above long
        if prev_short <= prev_long and curr_short > curr_long:
            return {
                "type": "golden_cross",
                "bars_ago": i - 1,
                "gap_pct": round(gap_pct, 3),
            }
        # Death cross: short crosses below long
        if prev_short >= prev_long and curr_short < curr_long:
            return {
                "type": "death_cross",
                "bars_ago": i - 1,
                "gap_pct": round(gap_pct, 3),
            }

    # No crossover found, check if converging
    if abs(gap_pct) < 1.0:
        return {
            "type": "converging",
            "bars_ago": None,
            "gap_pct": round(gap_pct, 3),
        }

    return {
        "type": "none",
        "bars_ago": None,
        "gap_pct": round(gap_pct, 3),
    }


def compute_roc(values: list[float], period: int) -> Optional[float]:
    """
    Compute Rate of Change (%) over `period` data points.

    Args:
        values: Series (most recent first)
        period: Number of periods back to compare

    Returns:
        ROC as percentage, or None if insufficient data
    """
    if len(values) <= period:
        return None
    current = values[0]
    past = values[period]
    if past == 0:
        return None
    return (current - past) / past * 100


def compute_percentile(values: list[float], current: float) -> Optional[float]:
    """
    Compute percentile rank of current value within the series.

    Returns percentile (0-100), or None if insufficient data.
    """
    if not values:
        return None
    below = sum(1 for v in values if v < current)
    return below / len(values) * 100


def compute_rolling_correlation(
    series_a: list[float], series_b: list[float], window: int
) -> Optional[float]:
    """
    Compute rolling Pearson correlation between two series over a window.

    Args:
        series_a: First series (most recent first)
        series_b: Second series (most recent first)
        window: Number of data points for correlation window

    Returns:
        Correlation coefficient (-1 to 1), or None if insufficient data
    """
    if len(series_a) < window or len(series_b) < window:
        return None

    a = series_a[:window]
    b = series_b[:window]

    n = window
    mean_a = sum(a) / n
    mean_b = sum(b) / n

    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n)) / n
    std_a = (sum((x - mean_a) ** 2 for x in a) / n) ** 0.5
    std_b = (sum((x - mean_b) ** 2 for x in b) / n) ** 0.5

    if std_a == 0 or std_b == 0:
        return 0.0

    return cov / (std_a * std_b)


STALE_CROSSOVER_MONTHS = 3


def determine_direction(
    crossover: dict,
    roc_3m: Optional[float],
    positive_label: str,
    negative_label: str,
    neutral_label: str = "neutral",
) -> tuple[str, str]:
    """
    Determine direction from crossover and momentum, accounting for stale crossovers.

    When a crossover is old (>= STALE_CROSSOVER_MONTHS) and momentum contradicts it,
    momentum takes priority ("reversing"). Recent crossovers always win.

    Args:
        crossover: Dict with 'type' and 'bars_ago'
        roc_3m: 3-month rate of change (%)
        positive_label: Label for positive direction (e.g., "risk_on")
        negative_label: Label for negative direction (e.g., "risk_off")
        neutral_label: Label when no signal (default "neutral")

    Returns:
        Tuple of (direction, momentum_qualifier)
        momentum_qualifier: "confirmed" | "fading" | "reversing" | "N/A"
    """
    cross_type = crossover.get("type", "none")
    bars_ago = crossover.get("bars_ago")
    is_stale = bars_ago is not None and bars_ago >= STALE_CROSSOVER_MONTHS

    # Crossover direction
    cross_dir = (
        positive_label
        if cross_type == "golden_cross"
        else negative_label
        if cross_type == "death_cross"
        else None
    )

    # Momentum direction
    mom_dir = (
        positive_label
        if roc_3m is not None and roc_3m > 0
        else negative_label
        if roc_3m is not None and roc_3m < 0
        else None
    )

    if cross_dir:
        if is_stale and mom_dir and mom_dir != cross_dir:
            return mom_dir, "reversing"
        qualifier = (
            "confirmed"
            if mom_dir == cross_dir
            else "fading"
            if mom_dir and mom_dir != cross_dir
            else "N/A"
        )
        return cross_dir, qualifier
    elif mom_dir:
        return mom_dir, "N/A"
    else:
        return neutral_label, "N/A"


def score_transition_signal(
    crossover: dict,
    roc_short: Optional[float],
    roc_long: Optional[float],
    sma_short: Optional[float],
    sma_long: Optional[float],
) -> int:
    """
    Score transition signal strength (0-100) from crossover, momentum, and MA data.

    Scoring layers:
    1. MA Crossover (0-40 base): Recent crossover = high, converging = moderate
    2. Momentum Shift (0-30): Short ROC reversal against long trend = early warning
    3. Confirmation (0-30): Multiple signals aligning = strong confirmation

    Returns:
        int score 0-100
    """
    score = 0

    # Layer 1: Crossover detection (0-40)
    cross_type = crossover.get("type", "none")
    bars_ago = crossover.get("bars_ago")
    gap_pct = crossover.get("gap_pct", 0) or 0

    if cross_type in ("golden_cross", "death_cross"):
        if bars_ago is not None and bars_ago <= 2:
            score += 40  # Very recent crossover
        elif bars_ago is not None and bars_ago <= 5:
            score += 30  # Recent crossover
        else:
            score += 20  # Older crossover
    elif cross_type == "converging":
        # MAs getting close, crossover possible
        closeness = max(0, 1.0 - abs(gap_pct)) * 25
        score += int(closeness)
    # "none" = stable, no points

    # Layer 2: Momentum shift (0-30)
    if roc_short is not None and roc_long is not None:
        # Reversal: short-term momentum opposite to long-term trend
        if roc_long < 0 and roc_short > 0:
            # Declining long-term but short-term bouncing = early reversal
            strength = min(abs(roc_short), 5.0) / 5.0 * 30
            score += int(strength)
        elif roc_long > 0 and roc_short < 0:
            # Rising long-term but short-term declining = early reversal
            strength = min(abs(roc_short), 5.0) / 5.0 * 30
            score += int(strength)
        elif abs(roc_short) > 3.0:
            # Strong short-term momentum in same direction = acceleration
            score += 10

    # Layer 3: Confirmation / alignment (0-30)
    signals_aligned = 0

    # Signal 1: Crossover present
    if cross_type in ("golden_cross", "death_cross"):
        signals_aligned += 1

    # Signal 2: Short ROC confirms direction
    if cross_type == "golden_cross" and roc_short is not None and roc_short > 0:
        signals_aligned += 1
    elif cross_type == "death_cross" and roc_short is not None and roc_short < 0:
        signals_aligned += 1

    # Signal 3: SMA gap widening (momentum)
    if sma_short is not None and sma_long is not None and sma_long != 0:
        current_gap = abs(sma_short - sma_long) / sma_long * 100
        if current_gap > 0.5:
            signals_aligned += 1

    score += signals_aligned * 10

    return min(100, max(0, score))
