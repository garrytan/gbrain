#!/usr/bin/env python3
"""
Market Breadth Analyzer - Score History Tracker

Persists composite scores keyed by data date (the latest date in the CSV),
enabling trend analysis across consecutive runs.

History file format: JSON array of entries, each with:
  - data_date: str (YYYY-MM-DD) — the date of the analyzed data
  - composite_score: float (0-100)
  - component_scores: dict (component key -> score)
  - recorded_at: str (ISO timestamp of when the entry was recorded)

Max 20 entries retained; oldest pruned first.
Same data_date re-run overwrites the existing entry.
"""

import json
import os
from datetime import datetime
from typing import Any


def load_history(path: str) -> list[dict]:
    """Load history from JSON file. Returns [] on missing/corrupt file."""
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            content = f.read().strip()
            if not content:
                return []
            data = json.loads(content)
            if isinstance(data, list):
                return data
            return []
    except (json.JSONDecodeError, OSError):
        return []


def append_history(
    path: str,
    composite_score: float,
    component_scores: dict[str, Any],
    data_date: str,
) -> list[dict]:
    """Append or overwrite an entry for *data_date*, then save.

    Returns the updated history list.
    """
    history = load_history(path)

    entry = {
        "data_date": data_date,
        "composite_score": composite_score,
        "component_scores": component_scores,
        "recorded_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    # Overwrite if same data_date exists
    history = [h for h in history if h.get("data_date") != data_date]
    history.append(entry)

    # Sort by data_date ascending
    history.sort(key=lambda h: h.get("data_date", ""))

    # Prune to max 20 entries
    if len(history) > 20:
        history = history[-20:]

    with open(path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, default=str)

    return history


def get_trend_summary(history: list[dict], n: int = 5) -> dict:
    """Compute trend direction from the last *n* entries.

    Returns:
        Dict with delta, direction ("improving"/"deteriorating"/"stable"),
        and the entries used.
    """
    if not history:
        return {"delta": 0, "direction": "stable", "entries": []}

    recent = history[-n:]

    if len(recent) < 2:
        return {
            "delta": 0,
            "direction": "stable",
            "entries": recent,
        }

    first_score = recent[0]["composite_score"]
    last_score = recent[-1]["composite_score"]
    delta = round(last_score - first_score, 1)

    if delta > 2:
        direction = "improving"
    elif delta < -2:
        direction = "deteriorating"
    else:
        direction = "stable"

    return {
        "delta": delta,
        "direction": direction,
        "entries": recent,
    }
