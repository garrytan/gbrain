"""Tests for history_tracker.py — score history persistence."""

import json

import pytest
from history_tracker import append_history, get_trend_summary, load_history


@pytest.fixture
def tmp_history(tmp_path):
    """Return a path to a temporary history JSON file."""
    return str(tmp_path / "history.json")


class TestLoadHistory:
    def test_file_not_found(self, tmp_history):
        assert load_history(tmp_history) == []

    def test_empty_file(self, tmp_history):
        with open(tmp_history, "w", encoding="utf-8") as f:
            f.write("")
        assert load_history(tmp_history) == []

    def test_corrupt_file(self, tmp_history):
        with open(tmp_history, "w", encoding="utf-8") as f:
            f.write("{bad json")
        assert load_history(tmp_history) == []

    def test_valid_file(self, tmp_history):
        data = [{"data_date": "2025-01-01", "composite_score": 60.0}]
        with open(tmp_history, "w", encoding="utf-8") as f:
            json.dump(data, f)
        assert load_history(tmp_history) == data


class TestAppendHistory:
    def test_append_creates_file(self, tmp_history):
        append_history(tmp_history, 65.0, {"c1": 70}, "2025-01-10")
        history = load_history(tmp_history)
        assert len(history) == 1
        assert history[0]["composite_score"] == 65.0
        assert history[0]["data_date"] == "2025-01-10"

    def test_append_adds_entry(self, tmp_history):
        append_history(tmp_history, 60.0, {}, "2025-01-09")
        append_history(tmp_history, 65.0, {}, "2025-01-10")
        history = load_history(tmp_history)
        assert len(history) == 2

    def test_same_data_date_overwrites(self, tmp_history):
        append_history(tmp_history, 60.0, {"c1": 70}, "2025-01-10")
        append_history(tmp_history, 65.0, {"c1": 75}, "2025-01-10")
        history = load_history(tmp_history)
        assert len(history) == 1
        assert history[0]["composite_score"] == 65.0

    def test_pruning_at_20(self, tmp_history):
        for i in range(25):
            date = f"2025-01-{i + 1:02d}"
            append_history(tmp_history, 50.0 + i, {}, date)
        history = load_history(tmp_history)
        assert len(history) == 20
        # Oldest entries pruned
        assert history[0]["data_date"] == "2025-01-06"


class TestGetTrendSummary:
    def test_single_entry(self):
        history = [{"data_date": "2025-01-10", "composite_score": 60.0}]
        summary = get_trend_summary(history)
        assert summary["delta"] == 0
        assert summary["direction"] == "stable"
        assert len(summary["entries"]) == 1

    def test_improving_trend(self):
        history = [
            {"data_date": "2025-01-08", "composite_score": 50.0},
            {"data_date": "2025-01-09", "composite_score": 55.0},
            {"data_date": "2025-01-10", "composite_score": 60.0},
        ]
        summary = get_trend_summary(history)
        assert summary["delta"] == 10.0
        assert summary["direction"] == "improving"

    def test_deteriorating_trend(self):
        history = [
            {"data_date": "2025-01-08", "composite_score": 70.0},
            {"data_date": "2025-01-09", "composite_score": 65.0},
            {"data_date": "2025-01-10", "composite_score": 60.0},
        ]
        summary = get_trend_summary(history)
        assert summary["delta"] == -10.0
        assert summary["direction"] == "deteriorating"

    def test_stable_trend(self):
        history = [
            {"data_date": "2025-01-08", "composite_score": 60.0},
            {"data_date": "2025-01-09", "composite_score": 60.5},
            {"data_date": "2025-01-10", "composite_score": 60.0},
        ]
        summary = get_trend_summary(history)
        assert summary["direction"] == "stable"

    def test_n_limits_entries(self):
        history = [
            {"data_date": f"2025-01-{i + 1:02d}", "composite_score": 50.0 + i} for i in range(10)
        ]
        summary = get_trend_summary(history, n=3)
        assert len(summary["entries"]) == 3

    def test_empty_history(self):
        summary = get_trend_summary([])
        assert summary["delta"] == 0
        assert summary["direction"] == "stable"
        assert len(summary["entries"]) == 0
