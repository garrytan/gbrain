#!/usr/bin/env python3
"""
Market Breadth Analyzer - Report Generator

Generates JSON and Markdown reports for market breadth health analysis.
"""

import json


def generate_json_report(analysis: dict, output_file: str):
    """Save full analysis as JSON."""
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(analysis, f, indent=2, default=str)
    print(f"  JSON report saved to: {output_file}")


def generate_markdown_report(analysis: dict, output_file: str):
    """Generate comprehensive Markdown report."""
    lines = []
    composite = analysis.get("composite", {})
    components = analysis.get("components", {})
    metadata = analysis.get("metadata", {})
    freshness = metadata.get("data_freshness", {})

    score = composite.get("composite_score", 0)
    zone = composite.get("zone", "Unknown")
    exposure = composite.get("exposure_guidance", "N/A")

    # Header
    lines.append("# Market Breadth Analyzer Report")
    lines.append("")
    lines.append(f"**Generated:** {metadata.get('generated_at', 'N/A')}")
    lines.append("**Data Source:** TraderMonty Market Breadth CSV (no API key required)")
    latest = freshness.get("latest_date", "N/A")
    days_old = freshness.get("days_old", "?")
    last_modified = freshness.get("last_modified")
    lm_str = f" | CSV last modified: {last_modified}" if last_modified else ""
    lines.append(f"**Latest Data:** {latest} ({days_old} days old{lm_str})")
    lines.append(
        "**Live Dashboard:** [Interactive Chart]"
        "(https://tradermonty.github.io/market-breadth-analysis/)"
    )
    lines.append("")

    # Freshness warning
    warning = freshness.get("warning")
    if warning:
        lines.append(f"> **WARNING:** {warning}")
        lines.append("")

    # Overall Assessment
    lines.append("---")
    lines.append("")
    lines.append("## Overall Assessment")
    lines.append("")
    zone_emoji = _zone_emoji(composite.get("zone_color", ""))
    lines.append("| Metric | Value |")
    lines.append("|--------|-------|")
    lines.append(f"| **Composite Score** | **{score}/100** |")
    lines.append(f"| **Health Zone** | {zone_emoji} {zone} |")
    lines.append(f"| **Equity Exposure** | {exposure} |")
    lines.append(
        f"| **Strongest** | {composite.get('strongest_health', {}).get('label', 'N/A')} "
        f"({composite.get('strongest_health', {}).get('score', 0)}/100) |"
    )
    lines.append(
        f"| **Weakest** | {composite.get('weakest_health', {}).get('label', 'N/A')} "
        f"({composite.get('weakest_health', {}).get('score', 0)}/100) |"
    )
    dq = composite.get("data_quality", {})
    if dq:
        lines.append(f"| **Data Quality** | {dq.get('label', 'N/A')} |")
    lines.append("")

    # Guidance
    lines.append(f"> **Guidance:** {composite.get('guidance', '')}")
    c1_mod = components.get("breadth_level_trend", {}).get("direction_modifier", 0)
    c2_mod = components.get("ma_crossover", {}).get("direction_modifier", 0)
    if c1_mod < 0 or c2_mod < 0:
        lines.append(
            f"> **Caution:** 8MA is falling "
            f"(C1 modifier: {c1_mod:+d}, C2 modifier: {c2_mod:+d}). "
            f"Monitor for further deterioration."
        )
    lines.append("")

    # Component Scores Table
    lines.append("---")
    lines.append("")
    lines.append("## Component Scores")
    lines.append("")
    lines.append("| # | Component | Weight | Eff. Weight | Score | Contribution | Signal |")
    lines.append("|---|-----------|--------|-------------|-------|--------------|--------|")

    component_order = [
        "breadth_level_trend",
        "ma_crossover",
        "cycle_position",
        "bearish_signal",
        "historical_percentile",
        "divergence",
    ]

    excluded_components = composite.get("excluded_components", [])

    for i, key in enumerate(component_order, 1):
        comp = composite.get("component_scores", {}).get(key, {})
        detail = components.get(key, {})
        signal = detail.get("signal", "N/A")
        score_val = int(round(comp.get("score", 0)))
        weight_pct = f"{comp.get('weight', 0) * 100:.0f}%"
        eff_weight = comp.get("effective_weight", comp.get("weight", 0))
        eff_weight_pct = f"{eff_weight * 100:.0f}%"
        contribution = comp.get("weighted_contribution", 0)
        is_excluded = not comp.get("data_available", True)
        bar = _score_bar(score_val)

        label = comp.get("label", key)
        if is_excluded:
            label += " (excluded)"

        lines.append(
            f"| {i} | **{label}** | {weight_pct} | {eff_weight_pct} | "
            f"{bar} {score_val} | {contribution:.1f} | {signal} |"
        )

    lines.append("")

    if excluded_components:
        lines.append(
            f"> **Note:** {len(excluded_components)} component(s) excluded due to "
            f"insufficient data: {', '.join(excluded_components)}. "
            f"Weights have been redistributed among available components."
        )
        lines.append("")

    # Component Details
    lines.append("---")
    lines.append("")
    lines.append("## Component Details")
    lines.append("")

    # C1: Breadth Level & Trend
    c1 = components.get("breadth_level_trend", {})
    lines.append("### 1. Current Breadth Level & Trend")
    lines.append("")
    if c1:
        lines.append(f"- **8MA Level:** {c1.get('current_8ma', 0):.4f}")
        lines.append(f"- **200MA Level:** {c1.get('current_200ma', 0):.4f}")
        lines.append(f"- **200MA Trend:** {'Uptrend' if c1.get('trend') == 1 else 'Downtrend'}")
        lines.append(f"- **Level Score:** {c1.get('level_score', 'N/A')}")
        lines.append(f"- **Trend Score:** {c1.get('trend_score', 'N/A')}")
        if c1.get("ma8_direction"):
            lines.append(f"- **8MA Direction (5d):** {c1['ma8_direction']}")
            modifier = c1.get("direction_modifier", 0)
            if modifier != 0:
                lines.append(f"- **Direction Modifier:** {modifier:+d}")
    lines.append("")

    # C2: MA Crossover
    c2 = components.get("ma_crossover", {})
    lines.append("### 2. 8MA vs 200MA Crossover Dynamics")
    lines.append("")
    if c2:
        lines.append(f"- **Gap (8MA - 200MA):** {c2.get('gap', 0):+.4f}")
        lines.append(f"- **Gap Score:** {c2.get('gap_score', 'N/A')}")
        lines.append(f"- **8MA Direction (5d):** {c2.get('ma8_direction', 'N/A')}")
        lines.append(f"- **Direction Modifier:** {c2.get('direction_modifier', 0):+d}")
    lines.append("")

    # C3: Cycle Position
    c3 = components.get("cycle_position", {})
    lines.append("### 3. Peak/Trough Cycle Position")
    lines.append("")
    if c3:
        lines.append(f"- **Latest Marker:** {c3.get('latest_marker_type', 'None')}")
        lines.append(f"- **Days Since Marker:** {c3.get('days_since_marker', 'N/A')}")
        lines.append(f"- **8MA Trend:** {c3.get('ma8_trend', 'N/A')}")
        if c3.get("extreme_trough"):
            lines.append("- **Extreme Trough (8MA < 0.4):** Yes (+10 bonus)")
    lines.append("")

    # C4: Bearish Signal
    c4 = components.get("bearish_signal", {})
    lines.append("### 4. Bearish Signal Status")
    lines.append("")
    if c4:
        lines.append(f"- **Bearish Signal Active:** {'YES' if c4.get('signal_active') else 'No'}")
        lines.append(f"- **200MA Trend:** {'Uptrend' if c4.get('trend') == 1 else 'Downtrend'}")
        lines.append(f"- **Current 8MA:** {c4.get('current_8ma', 0):.4f}")
        in_pink = c4.get("in_pink_zone", False)
        pink_days = c4.get("pink_zone_days", 0)
        if in_pink:
            lines.append(
                f"- **Pink Zone:** YES ({pink_days} consecutive days) "
                f"- 200MA downtrend + 8MA below 200MA"
            )
        else:
            lines.append("- **Pink Zone:** No (outside bearish region)")
        lines.append(f"- **Base Score:** {c4.get('base_score', 'N/A')}")
        lines.append(f"- **Context Adjustment:** {c4.get('context_adjustment', 0):+d}")
        pink_adj = c4.get("pink_zone_adjustment", 0)
        if pink_adj != 0:
            lines.append(f"- **Pink Zone Adjustment:** {pink_adj:+d}")
    lines.append("")

    # C5: Historical Percentile
    c5 = components.get("historical_percentile", {})
    lines.append("### 5. Historical Percentile")
    lines.append("")
    if c5:
        lines.append(f"- **Current 8MA:** {c5.get('current_8ma', 0):.4f}")
        lines.append(f"- **Percentile Rank:** {c5.get('percentile_rank', 'N/A'):.1f}%")
        lines.append(f"- **Avg Peak (200MA):** {c5.get('avg_peak', 'N/A')}")
        lines.append(f"- **Avg Trough (8MA<0.4):** {c5.get('avg_trough', 'N/A')}")
        adj = c5.get("adjustment", 0)
        if adj != 0:
            label = "Overheated (-10)" if adj < 0 else "Oversold (+10)"
            lines.append(f"- **Adjustment:** {label}")
    lines.append("")

    # C6: Divergence
    c6 = components.get("divergence", {})
    lines.append("### 6. S&P 500 vs Breadth Divergence")
    lines.append("")
    if c6:
        lines.append(f"- **S&P 500 60d Change:** {c6.get('sp500_pct_change', 0):+.2f}%")
        lines.append(f"- **Breadth 8MA 60d Change:** {c6.get('breadth_change', 0):+.4f}")
        lines.append(f"- **Divergence Type:** {c6.get('divergence_type', 'N/A')}")

        # Dual-window details (new)
        w60 = c6.get("window_60d")
        w20 = c6.get("window_20d")
        if w60 and w20:
            lines.append("")
            lines.append(
                f"- **60-Day Window:** Score {w60['score']}, "
                f"{w60['divergence_type']} "
                f"(lookback: {w60.get('lookback_days', 60)}d)"
            )
            lines.append(
                f"- **20-Day Window:** Score {w20['score']}, "
                f"{w20['divergence_type']} "
                f"(lookback: {w20.get('lookback_days', 20)}d)"
            )

        if c6.get("early_warning"):
            lines.append("")
            lines.append(
                "> **Early Warning:** Short-term (20d) bearish divergence "
                "detected while long-term (60d) trend remains healthy. "
                "Monitor for potential deterioration."
            )
    lines.append("")

    # Score Trend (show N/A for single entry, full table for 2+)
    trend_summary = analysis.get("trend_summary")
    if trend_summary and len(trend_summary.get("entries", [])) >= 1:
        entries = trend_summary["entries"]
        lines.append("---")
        lines.append("")
        lines.append("## Score Trend")
        lines.append("")
        if len(entries) == 1:
            lines.append("**Direction:** N/A (single observation — trend requires 2+ data points)")
        else:
            direction = trend_summary["direction"].capitalize()
            delta = trend_summary["delta"]
            lines.append(
                f"**Direction:** {direction} ({delta:+.1f} over {len(entries)} observations)"
            )
            lines.append("")
            lines.append("| Date | Score |")
            lines.append("|------|-------|")
            for entry in entries:
                lines.append(f"| {entry['data_date']} | {entry['composite_score']:.1f} |")
        lines.append("")

    # Key Levels to Watch
    lines.append("---")
    lines.append("")
    lines.append("## Key Levels to Watch")
    lines.append("")
    key_levels = analysis.get("key_levels", {})
    if key_levels:
        lines.append("| Level | Value | Significance |")
        lines.append("|-------|-------|-------------|")
        for level_name, level_info in key_levels.items():
            lines.append(
                f"| {level_name} | {level_info.get('value', 'N/A')} | "
                f"{level_info.get('significance', '')} |"
            )
    else:
        lines.append("*No key levels computed.*")
    lines.append("")

    # Recommended Actions
    lines.append("---")
    lines.append("")
    lines.append("## Recommended Actions")
    lines.append("")
    lines.append(f"**Health Zone:** {zone}")
    lines.append(f"**Equity Exposure:** {exposure}")
    lines.append("")
    for action in composite.get("actions", []):
        lines.append(f"- {action}")
    # Inject cautionary actions when 8MA is falling
    c1_mod_act = components.get("breadth_level_trend", {}).get("direction_modifier", 0)
    c2_mod_act = components.get("ma_crossover", {}).get("direction_modifier", 0)
    if c1_mod_act < 0 or c2_mod_act < 0:
        lines.append("- Reduce new position sizes until 8MA stabilizes")
        lines.append("- Tighten stop-loss levels on existing positions")
    lines.append("")

    # Methodology
    lines.append("---")
    lines.append("")
    lines.append("## Methodology")
    lines.append("")
    lines.append(
        "This analysis uses TraderMonty's market breadth dataset to quantify "
        "market participation health across 6 dimensions:"
    )
    lines.append("")
    lines.append("1. **Breadth Level & Trend (25%):** Current 8MA level and 200MA trend direction")
    lines.append("2. **MA Crossover (20%):** Gap between 8MA and 200MA with momentum detection")
    lines.append("3. **Cycle Position (20%):** Position relative to recent peaks/troughs")
    lines.append("4. **Bearish Signal (15%):** Backtested bearish signal flag from dataset")
    lines.append("5. **Historical Percentile (10%):** Current level vs full history distribution")
    lines.append("6. **Divergence (10%):** S&P 500 price vs breadth directional agreement")
    lines.append("")
    lines.append(
        "Composite score: 0-100 (100 = maximum health). "
        "No API key required - uses freely available CSV data."
    )
    lines.append("")
    lines.append("For detailed methodology, see `references/breadth_analysis_methodology.md`.")
    lines.append("")

    # Disclaimer
    lines.append("---")
    lines.append("")
    lines.append(
        "**Disclaimer:** This analysis is for educational and informational purposes only. "
        "Not investment advice. Past patterns may not predict future outcomes. "
        "Conduct your own research and consult a financial advisor before making "
        "investment decisions."
    )
    lines.append("")

    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"  Markdown report saved to: {output_file}")


def _zone_emoji(color: str) -> str:
    mapping = {
        "green": "🟢",
        "blue": "🔵",
        "yellow": "🟡",
        "orange": "🟠",
        "red": "🔴",
    }
    return mapping.get(color, "⚪")


def _score_bar(score: int) -> str:
    """Text bar for score visualization (100 = full/healthy)."""
    if score >= 80:
        return "████"
    elif score >= 60:
        return "███░"
    elif score >= 40:
        return "██░░"
    elif score >= 20:
        return "█░░░"
    else:
        return "░░░░"
