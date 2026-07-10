#!/usr/bin/env python3
"""
Market Breadth Analyzer - Main Orchestrator

Quantifies market breadth health using TraderMonty's public CSV data.
Generates a 0-100 composite score across 6 components.
No API key required.

Usage:
    # Default (uses public CSV URLs):
    python3 market_breadth_analyzer.py

    # Custom URLs:
    python3 market_breadth_analyzer.py \\
        --detail-url "https://example.com/data.csv" \\
        --summary-url "https://example.com/summary.csv"

    # Custom output directory:
    python3 market_breadth_analyzer.py --output-dir ./reports

Output:
    - JSON: market_breadth_YYYY-MM-DD_HHMMSS.json
    - Markdown: market_breadth_YYYY-MM-DD_HHMMSS.md
"""

import argparse
import os
import sys
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from calculators.bearish_signal_calculator import calculate_bearish_signal
from calculators.cycle_calculator import calculate_cycle_position
from calculators.divergence_calculator import calculate_divergence
from calculators.historical_context_calculator import calculate_historical_percentile
from calculators.ma_crossover_calculator import calculate_ma_crossover
from calculators.trend_level_calculator import calculate_breadth_level_trend
from csv_client import (
    DEFAULT_DETAIL_URL,
    DEFAULT_SUMMARY_URL,
    check_data_freshness,
    fetch_detail_csv,
    fetch_summary_csv,
)
from history_tracker import append_history, get_trend_summary
from report_generator import generate_json_report, generate_markdown_report
from scorer import calculate_composite_score


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Market Breadth Analyzer - 6-Component Health Scoring"
    )

    parser.add_argument(
        "--detail-url",
        default=DEFAULT_DETAIL_URL,
        help="URL for detail CSV (market_breadth_data.csv)",
    )
    parser.add_argument(
        "--summary-url",
        default=DEFAULT_SUMMARY_URL,
        help="URL for summary CSV (market_breadth_summary.csv)",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Output directory for reports (default: current directory)",
    )

    return parser.parse_args()


def main():
    args = parse_arguments()

    print("=" * 70)
    print("Market Breadth Analyzer")
    print("6-Component Health Scoring (No API Key Required)")
    print("=" * 70)
    print()

    # ========================================================================
    # Step 1: Fetch CSV Data
    # ========================================================================
    print("Step 1: Fetching CSV Data")
    print("-" * 70)

    detail_rows = fetch_detail_csv(args.detail_url)
    if not detail_rows:
        print("ERROR: Cannot proceed without detail CSV data", file=sys.stderr)
        sys.exit(1)

    summary = fetch_summary_csv(args.summary_url)

    freshness = check_data_freshness(detail_rows)
    if freshness.get("warning"):
        print(f"  WARNING: {freshness['warning']}")
    else:
        print(
            f"  Data freshness: OK "
            f"(latest: {freshness['latest_date']}, {freshness['days_old']} days old)"
        )

    print()

    # ========================================================================
    # Step 2: Calculate Components
    # ========================================================================
    print("Step 2: Calculating Components")
    print("-" * 70)

    # Component 1: Current Breadth Level & Trend (25%)
    print("  [1/6] Current Breadth Level & Trend...", end=" ", flush=True)
    comp1 = calculate_breadth_level_trend(detail_rows)
    print(f"Score: {comp1['score']} ({comp1['signal']})")

    # Component 2: 8MA vs 200MA Crossover (20%)
    print("  [2/6] 8MA vs 200MA Crossover...", end=" ", flush=True)
    comp2 = calculate_ma_crossover(detail_rows)
    print(f"Score: {comp2['score']} ({comp2['signal']})")

    # Component 3: Peak/Trough Cycle Position (20%)
    print("  [3/6] Peak/Trough Cycle Position...", end=" ", flush=True)
    comp3 = calculate_cycle_position(detail_rows)
    print(f"Score: {comp3['score']} ({comp3['signal']})")

    # Component 4: Bearish Signal Status (15%)
    print("  [4/6] Bearish Signal Status...", end=" ", flush=True)
    comp4 = calculate_bearish_signal(detail_rows)
    print(f"Score: {comp4['score']} ({comp4['signal']})")

    # Component 5: Historical Percentile (10%)
    print("  [5/6] Historical Percentile...", end=" ", flush=True)
    comp5 = calculate_historical_percentile(detail_rows, summary)
    print(f"Score: {comp5['score']} ({comp5['signal']})")

    # Component 6: S&P 500 vs Breadth Divergence (10%)
    print("  [6/6] S&P 500 vs Breadth Divergence...", end=" ", flush=True)
    comp6 = calculate_divergence(detail_rows)
    print(f"Score: {comp6['score']} ({comp6['signal']})")

    print()

    # ========================================================================
    # Step 3: Composite Score
    # ========================================================================
    print("Step 3: Calculating Composite Score")
    print("-" * 70)

    component_scores = {
        "breadth_level_trend": comp1["score"],
        "ma_crossover": comp2["score"],
        "cycle_position": comp3["score"],
        "bearish_signal": comp4["score"],
        "historical_percentile": comp5["score"],
        "divergence": comp6["score"],
    }

    data_availability = {
        "breadth_level_trend": comp1.get("data_available", True),
        "ma_crossover": comp2.get("data_available", True),
        "cycle_position": comp3.get("data_available", True),
        "bearish_signal": comp4.get("data_available", True),
        "historical_percentile": comp5.get("data_available", True),
        "divergence": comp6.get("data_available", True),
    }

    composite = calculate_composite_score(component_scores, data_availability)

    print(f"  Composite Score: {composite['composite_score']}/100")
    print(f"  Health Zone: {composite['zone']}")
    print(f"  Equity Exposure: {composite['exposure_guidance']}")
    print(
        f"  Strongest: {composite['strongest_health']['label']} "
        f"({composite['strongest_health']['score']})"
    )
    print(
        f"  Weakest: {composite['weakest_health']['label']} "
        f"({composite['weakest_health']['score']})"
    )
    print()

    # ========================================================================
    # Step 3.5: Score History & Trend
    # ========================================================================
    data_date = detail_rows[-1]["Date"]
    history_file = os.path.join(args.output_dir, "market_breadth_history.json")
    updated_history = append_history(
        history_file,
        composite["composite_score"],
        component_scores,
        data_date,
    )
    trend_summary = get_trend_summary(updated_history)
    if trend_summary["direction"] != "stable" and len(trend_summary["entries"]) >= 2:
        print(
            f"  Score Trend: {trend_summary['direction']} "
            f"(delta {trend_summary['delta']:+.1f} over "
            f"{len(trend_summary['entries'])} observations)"
        )
    print()

    # ========================================================================
    # Step 4: Key Levels
    # ========================================================================
    key_levels = _compute_key_levels(detail_rows, summary)

    # ========================================================================
    # Step 5: Generate Reports
    # ========================================================================
    print("Step 4: Generating Reports")
    print("-" * 70)

    analysis = {
        "metadata": {
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "data_source": "TraderMonty Market Breadth CSV",
            "detail_url": args.detail_url,
            "summary_url": args.summary_url,
            "total_rows": len(detail_rows),
            "data_freshness": freshness,
        },
        "composite": composite,
        "components": {
            "breadth_level_trend": comp1,
            "ma_crossover": comp2,
            "cycle_position": comp3,
            "bearish_signal": comp4,
            "historical_percentile": comp5,
            "divergence": comp6,
        },
        "trend_summary": trend_summary,
        "key_levels": key_levels,
    }

    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    json_file = os.path.join(args.output_dir, f"market_breadth_{timestamp}.json")
    md_file = os.path.join(args.output_dir, f"market_breadth_{timestamp}.md")

    generate_json_report(analysis, json_file)
    generate_markdown_report(analysis, md_file)

    print()
    print("=" * 70)
    print("Market Breadth Analysis Complete")
    print("=" * 70)
    print(f"  Composite Score: {composite['composite_score']}/100")
    print(f"  Health Zone: {composite['zone']}")
    print(f"  Equity Exposure: {composite['exposure_guidance']}")
    print(f"  JSON Report: {json_file}")
    print(f"  Markdown Report: {md_file}")
    print()


def _compute_key_levels(rows, summary):
    """Compute key breadth levels to watch."""
    if not rows:
        return {}

    latest = rows[-1]
    latest["Breadth_Index_8MA"]
    ma200 = latest["Breadth_Index_200MA"]

    levels = {}

    # 200MA crossover level
    levels["200MA Level"] = {
        "value": f"{ma200:.4f}",
        "significance": (
            "Key support/resistance for 8MA. "
            "8MA crossing below is an early warning of deterioration, "
            "not a standalone bearish signal."
        ),
    }

    # 0.40 extreme weakness threshold
    levels["Extreme Weakness (0.40)"] = {
        "value": "0.4000",
        "significance": (
            "8MA below 0.40 marks extreme weakness. "
            "Historically, troughs at this level precede significant rallies."
        ),
    }

    # 0.60 healthy threshold
    levels["Healthy Threshold (0.60)"] = {
        "value": "0.6000",
        "significance": (
            "8MA above 0.60 indicates broad participation. "
            "Below 0.60 = selective market, above = inclusive rally."
        ),
    }

    # Average peak from summary
    avg_peak_str = summary.get("Average Peaks (200MA)", "")
    try:
        avg_peak = float(avg_peak_str)
        levels["Historical Avg Peak"] = {
            "value": f"{avg_peak:.3f}",
            "significance": (
                "Average peak level. Approaching this level suggests "
                "breadth may be near a cyclical high."
            ),
        }
    except (ValueError, TypeError):
        pass

    # Average trough from summary
    avg_trough_str = summary.get("Average Troughs (8MA < 0.4)", "")
    try:
        avg_trough = float(avg_trough_str)
        levels["Historical Avg Trough"] = {
            "value": f"{avg_trough:.3f}",
            "significance": (
                "Average extreme trough level. Reaching this level "
                "is a potential contrarian buy signal."
            ),
        }
    except (ValueError, TypeError):
        pass

    return levels


if __name__ == "__main__":
    main()
