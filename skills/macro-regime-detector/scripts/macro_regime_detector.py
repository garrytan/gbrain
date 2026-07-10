#!/usr/bin/env python3
"""
Macro Regime Detector - Main Orchestrator

Detects structural macro regime transitions (1-2 year horizon) using
cross-asset ratio analysis on monthly data.

6 Components:
1. Market Concentration (RSP/SPY) - 25%
2. Yield Curve (10Y-2Y spread) - 20%
3. Credit Conditions (HYG/LQD) - 15%
4. Size Factor (IWM/SPY) - 15%
5. Equity-Bond (SPY/TLT + correlation) - 15%
6. Sector Rotation (XLY/XLP) - 10%

5 Regime Classifications:
- Concentration, Broadening, Contraction, Inflationary, Transitional

Usage:
    # With FMP API key in environment:
    export FMP_API_KEY=YOUR_KEY
    python3 macro_regime_detector.py

    # With explicit API key:
    python3 macro_regime_detector.py --api-key YOUR_KEY

    # Custom output directory:
    python3 macro_regime_detector.py --output-dir ./reports

Output:
    - JSON: macro_regime_YYYY-MM-DD_HHMMSS.json
    - Markdown: macro_regime_YYYY-MM-DD_HHMMSS.md
"""

import argparse
import os
import sys
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from calculators.concentration_calculator import calculate_concentration
from calculators.credit_conditions_calculator import calculate_credit_conditions
from calculators.equity_bond_calculator import calculate_equity_bond
from calculators.sector_rotation_calculator import calculate_sector_rotation
from calculators.size_factor_calculator import calculate_size_factor
from calculators.yield_curve_calculator import calculate_yield_curve
from fmp_client import FMPClient
from report_generator import generate_json_report, generate_markdown_report
from scorer import calculate_composite_score, check_regime_consistency, classify_regime

# ETF symbols needed for analysis
REQUIRED_ETFS = ["RSP", "SPY", "IWM", "TLT", "SHY", "HYG", "LQD", "XLY", "XLP"]
HISTORY_DAYS = 600  # ~2.4 years of daily data


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Macro Regime Detector - Cross-Asset Ratio Analysis"
    )
    parser.add_argument(
        "--api-key", help="FMP API key (defaults to FMP_API_KEY environment variable)"
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Output directory for reports (default: current directory)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=HISTORY_DAYS,
        help=f"Days of historical data to fetch (default: {HISTORY_DAYS})",
    )
    return parser.parse_args()


def main():
    args = parse_arguments()

    print("=" * 70)
    print("Macro Regime Detector")
    print("Cross-Asset Ratio Analysis for Structural Regime Transitions")
    print("=" * 70)
    print()

    # Initialize FMP client
    try:
        client = FMPClient(api_key=args.api_key)
        print("FMP API client initialized")
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # ================================================================
    # Step 1: Fetch Market Data (9 ETFs + Treasury rates = 10 API calls)
    # ================================================================
    print()
    print("Step 1/4: Fetching Market Data")
    print("-" * 70)

    historical = {}
    for etf in REQUIRED_ETFS:
        print(f"  Fetching {etf} ({args.days} days)...", end=" ", flush=True)
        data = client.get_historical_prices(etf, days=args.days)
        if data and "historical" in data:
            historical[etf] = data["historical"]
            print(f"OK ({len(historical[etf])} bars)")
        else:
            print("FAILED")
            historical[etf] = []

    # Critical check: need at least SPY
    if not historical.get("SPY"):
        print("ERROR: Cannot proceed without SPY data", file=sys.stderr)
        sys.exit(1)

    # Fetch treasury rates
    print("  Fetching Treasury rates...", end=" ", flush=True)
    treasury_rates = client.get_treasury_rates(days=args.days)
    if treasury_rates:
        print(f"OK ({len(treasury_rates)} entries)")
    else:
        print("WARN - Treasury API unavailable, using SHY/TLT fallback")

    print()

    # ================================================================
    # Step 2: Calculate 6 Components
    # ================================================================
    print("Step 2/4: Calculating Components")
    print("-" * 70)

    # Component 1: Market Concentration (25%)
    print("  [1/6] Market Concentration (RSP/SPY)...", end=" ", flush=True)
    comp1 = calculate_concentration(
        rsp_history=historical.get("RSP", []),
        spy_history=historical.get("SPY", []),
    )
    print(f"Score: {comp1['score']} ({comp1['signal'][:60]})")

    # Component 2: Yield Curve (20%)
    print("  [2/6] Yield Curve (10Y-2Y)...", end=" ", flush=True)
    comp2 = calculate_yield_curve(
        treasury_rates=treasury_rates,
        shy_history=historical.get("SHY", []),
        tlt_history=historical.get("TLT", []),
    )
    print(f"Score: {comp2['score']} ({comp2['signal'][:60]})")

    # Component 3: Credit Conditions (15%)
    print("  [3/6] Credit Conditions (HYG/LQD)...", end=" ", flush=True)
    comp3 = calculate_credit_conditions(
        hyg_history=historical.get("HYG", []),
        lqd_history=historical.get("LQD", []),
    )
    print(f"Score: {comp3['score']} ({comp3['signal'][:60]})")

    # Component 4: Size Factor (15%)
    print("  [4/6] Size Factor (IWM/SPY)...", end=" ", flush=True)
    comp4 = calculate_size_factor(
        iwm_history=historical.get("IWM", []),
        spy_history=historical.get("SPY", []),
    )
    print(f"Score: {comp4['score']} ({comp4['signal'][:60]})")

    # Component 5: Equity-Bond Relationship (15%)
    print("  [5/6] Equity-Bond (SPY/TLT)...", end=" ", flush=True)
    comp5 = calculate_equity_bond(
        spy_history=historical.get("SPY", []),
        tlt_history=historical.get("TLT", []),
    )
    print(f"Score: {comp5['score']} ({comp5['signal'][:60]})")

    # Component 6: Sector Rotation (10%)
    print("  [6/6] Sector Rotation (XLY/XLP)...", end=" ", flush=True)
    comp6 = calculate_sector_rotation(
        xly_history=historical.get("XLY", []),
        xlp_history=historical.get("XLP", []),
    )
    print(f"Score: {comp6['score']} ({comp6['signal'][:60]})")

    print()

    # ================================================================
    # Step 3: Composite Score & Regime Classification
    # ================================================================
    print("Step 3/4: Scoring & Classification")
    print("-" * 70)

    component_scores = {
        "concentration": comp1["score"],
        "yield_curve": comp2["score"],
        "credit_conditions": comp3["score"],
        "size_factor": comp4["score"],
        "equity_bond": comp5["score"],
        "sector_rotation": comp6["score"],
    }

    data_availability = {
        "concentration": comp1.get("data_available", False),
        "yield_curve": comp2.get("data_available", False),
        "credit_conditions": comp3.get("data_available", False),
        "size_factor": comp4.get("data_available", False),
        "equity_bond": comp5.get("data_available", False),
        "sector_rotation": comp6.get("data_available", False),
    }

    composite = calculate_composite_score(component_scores, data_availability)

    component_results = {
        "concentration": comp1,
        "yield_curve": comp2,
        "credit_conditions": comp3,
        "size_factor": comp4,
        "equity_bond": comp5,
        "sector_rotation": comp6,
    }

    regime = classify_regime(component_results)
    regime["consistency"] = check_regime_consistency(regime["current_regime"], component_results)

    print(f"  Composite Score: {composite['composite_score']}/100")
    print(f"  Signal Zone: {composite['zone']}")
    print(f"  Current Regime: {regime['regime_label']} (confidence: {regime['confidence']})")
    print(f"  Transition Probability: {regime['transition_probability']['probability_range']}")
    print(f"  Components Signaling: {composite['signaling_components']}/6")
    print()

    # ================================================================
    # Step 4: Generate Reports
    # ================================================================
    print("Step 4/4: Generating Reports")
    print("-" * 70)

    analysis = {
        "metadata": {
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "data_source": "FMP API",
            "history_days": args.days,
            "api_calls": client.get_api_stats(),
            "etfs_analyzed": REQUIRED_ETFS,
            "treasury_data_available": treasury_rates is not None,
        },
        "composite": composite,
        "regime": regime,
        "components": component_results,
    }

    os.makedirs(args.output_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    json_file = os.path.join(args.output_dir, f"macro_regime_{timestamp}.json")
    md_file = os.path.join(args.output_dir, f"macro_regime_{timestamp}.md")

    generate_json_report(analysis, json_file)
    generate_markdown_report(analysis, md_file)

    print()
    print("=" * 70)
    print("Macro Regime Detection Complete")
    print("=" * 70)
    print(f"  Composite Score: {composite['composite_score']}/100")
    print(f"  Current Regime: {regime['regime_label']}")
    print(f"  Transition Probability: {regime['transition_probability']['probability_range']}")
    print(f"  JSON Report: {json_file}")
    print(f"  Markdown Report: {md_file}")
    print()

    stats = client.get_api_stats()
    print("API Usage:")
    print(f"  API calls made: {stats['api_calls_made']}")
    print(f"  Cache entries: {stats['cache_entries']}")
    print()


if __name__ == "__main__":
    main()
