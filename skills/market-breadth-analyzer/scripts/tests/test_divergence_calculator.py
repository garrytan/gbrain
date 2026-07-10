"""Tests for Component 6: Divergence Calculator — dual-window."""

from calculators.divergence_calculator import calculate_divergence


def _make_divergence_rows(make_row, n, sp_start=5000, sp_end=5100, ma8_start=0.50, ma8_end=0.55):
    """Create n rows with linear interpolation of S&P and 8MA."""
    rows = []
    for i in range(n):
        frac = i / max(n - 1, 1)
        sp = sp_start + (sp_end - sp_start) * frac
        ma8 = ma8_start + (ma8_end - ma8_start) * frac
        rows.append(
            make_row(
                **{
                    "S&P500_Price": sp,
                    "Breadth_Index_8MA": ma8,
                    "Date": f"2025-01-{i + 1:02d}",
                }
            )
        )
    return rows


class TestDualWindow:
    """Both windows should be present in output."""

    def test_both_windows_present(self, make_row):
        rows = _make_divergence_rows(make_row, 80)
        result = calculate_divergence(rows)
        assert "window_60d" in result
        assert "window_20d" in result

    def test_composite_score_formula(self, make_row):
        """Composite = 60d * 0.6 + 20d * 0.4."""
        rows = _make_divergence_rows(make_row, 80)
        result = calculate_divergence(rows)
        w60 = result["window_60d"]["score"]
        w20 = result["window_20d"]["score"]
        expected = round(w60 * 0.6 + w20 * 0.4, 1)
        # Allow small rounding tolerance
        assert abs(result["score"] - expected) <= 0.1

    def test_early_warning_flag(self, make_row):
        """20d bearish (<=25) & 60d healthy (>=50) -> early_warning True."""
        # First 60 rows: SP and breadth both rising strongly
        # -> 60d window sees both up -> score=70 (>=50)
        rows = _make_divergence_rows(
            make_row, 60, sp_start=5000, sp_end=5200, ma8_start=0.35, ma8_end=0.65
        )
        # Last 20 rows: SP up >3% but breadth down sharply (<-0.05)
        # -> 20d window score=10 (<=25)
        for i in range(20):
            frac = i / 19
            row = make_row(
                **{
                    "S&P500_Price": 5200 + 200 * frac,
                    "Breadth_Index_8MA": 0.65 - 0.15 * frac,
                    "Date": f"2025-03-{i + 1:02d}",
                }
            )
            rows.append(row)
        result = calculate_divergence(rows)
        assert result["early_warning"] is True

    def test_early_warning_false_when_both_healthy(self, make_row):
        """Both windows healthy -> early_warning False."""
        rows = _make_divergence_rows(
            make_row, 80, sp_start=5000, sp_end=5100, ma8_start=0.50, ma8_end=0.55
        )
        result = calculate_divergence(rows)
        assert result["early_warning"] is False

    def test_backward_compat_top_level_keys(self, make_row):
        """Top-level keys sp500_pct_change, breadth_change, divergence_type
        should still be from the 60d window."""
        rows = _make_divergence_rows(make_row, 80)
        result = calculate_divergence(rows)
        assert "sp500_pct_change" in result
        assert "breadth_change" in result
        assert "divergence_type" in result


class TestShortData:
    """20-59 rows should still produce a valid score."""

    def test_30_rows_uses_shortened_60d_window(self, make_row):
        rows = _make_divergence_rows(make_row, 30)
        result = calculate_divergence(rows)
        assert result["data_available"] is True
        assert result["window_60d"]["lookback_days"] == 30

    def test_20_rows_minimum(self, make_row):
        rows = _make_divergence_rows(make_row, 20)
        result = calculate_divergence(rows)
        assert result["data_available"] is True

    def test_fewer_than_20_unavailable(self, make_row):
        rows = _make_divergence_rows(make_row, 15)
        result = calculate_divergence(rows)
        assert result["data_available"] is False

    def test_60d_lookback_days_correct(self, make_row):
        """With 45 rows, 60d window lookback should be 45."""
        rows = _make_divergence_rows(make_row, 45)
        result = calculate_divergence(rows)
        assert result["window_60d"]["lookback_days"] == 45

    def test_20d_lookback_correct(self, make_row):
        rows = _make_divergence_rows(make_row, 80)
        result = calculate_divergence(rows)
        assert result["window_20d"]["lookback_days"] == 20


class TestNearFlat:
    """Near-flat classification for noise-level movements."""

    def test_near_flat_both_tiny_movements(self):
        from calculators.divergence_calculator import _score_divergence

        score, label = _score_divergence(0.3, 0.005)
        assert "Near-flat" in label

    def test_not_flat_when_sp_significant(self):
        from calculators.divergence_calculator import _score_divergence

        score, label = _score_divergence(1.0, 0.005)
        assert "Near-flat" not in label

    def test_not_flat_when_breadth_significant(self):
        from calculators.divergence_calculator import _score_divergence

        score, label = _score_divergence(0.3, 0.02)
        assert "Near-flat" not in label

    def test_near_flat_both_negative_tiny(self):
        from calculators.divergence_calculator import _score_divergence

        score, label = _score_divergence(-0.2, -0.003)
        assert "Near-flat" in label

    def test_not_flat_when_sp_exactly_at_threshold(self):
        from calculators.divergence_calculator import _score_divergence

        score, label = _score_divergence(0.5, 0.005)
        assert "Near-flat" not in label
