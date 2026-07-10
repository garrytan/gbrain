"""Importable test helpers for Macro Regime Detector tests"""


def make_daily_bar(close, volume=1000000, date="2026-01-15", open_=None, high=None, low=None):
    """Helper to create a daily OHLCV bar dict."""
    if open_ is None:
        open_ = close
    if high is None:
        high = close * 1.005
    if low is None:
        low = close * 0.995
    return {
        "date": date,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "adjClose": close,
        "volume": volume,
    }


def make_history(closes, base_volume=1000000, start_date="2026-01-15"):
    """Create a list of daily bars from a list of closes (most recent first)."""
    bars = []
    for i, close in enumerate(closes):
        vol = base_volume + (i * 1000)
        bars.append(
            make_daily_bar(
                close=close,
                volume=vol,
                date=f"day-{i}",
            )
        )
    return bars


def make_monthly_history(monthly_closes, start_year=2024, start_month=1):
    """
    Create daily history that downsamples to expected monthly points.

    Each monthly close gets 20 daily bars in its month.
    Monthly_closes should be in chronological order (oldest first).
    Returns bars in most-recent-first order.
    """
    bars = []
    for i, close in enumerate(monthly_closes):
        month = start_month + i
        year = start_year + (month - 1) // 12
        m = ((month - 1) % 12) + 1

        for day in range(1, 21):
            daily_close = close * (1 + (day - 10) * 0.001)
            date_str = f"{year:04d}-{m:02d}-{day:02d}"
            bars.append(
                make_daily_bar(
                    close=daily_close,
                    date=date_str,
                    volume=1000000,
                )
            )

    bars.reverse()
    return bars


def make_treasury_rates(spreads, start_year=2024, start_month=1):
    """
    Create treasury rate data from a list of 10Y-2Y spreads.
    """
    entries = []
    for i, spread in enumerate(spreads):
        month = start_month + i
        year = start_year + (month - 1) // 12
        m = ((month - 1) % 12) + 1

        for day in range(1, 21):
            date_str = f"{year:04d}-{m:02d}-{day:02d}"
            year2 = 4.5 - spread / 2
            year10 = 4.5 + spread / 2
            entries.append(
                {
                    "date": date_str,
                    "year2": str(round(year2, 2)),
                    "year10": str(round(year10, 2)),
                }
            )

    entries.reverse()
    return entries
