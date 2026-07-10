#!/usr/bin/env python3
"""
Macro Regime Detector - Report Generator

Generates JSON and Markdown reports for macro regime detection analysis.
"""

import json


def generate_json_report(analysis: dict, output_file: str):
    """Save full analysis as JSON"""
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(analysis, f, indent=2, default=str)
    print(f"JSON report saved to: {output_file}")


def generate_markdown_report(analysis: dict, output_file: str):
    """Generate comprehensive Markdown report"""
    lines = []
    composite = analysis.get("composite", {})
    regime = analysis.get("regime", {})
    components = analysis.get("components", {})
    metadata = analysis.get("metadata", {})

    score = composite.get("composite_score", 0)
    zone = composite.get("zone", "Unknown")

    # Header
    lines.append("# Macro Regime Detector Report")
    lines.append("")
    lines.append(f"**Generated:** {metadata.get('generated_at', 'N/A')}")
    lines.append(
        f"**Data Source:** FMP API ({metadata.get('api_calls', {}).get('api_calls_made', 'N/A')} calls)"
    )
    lines.append("")

    # ================================================================
    # Section 1: Current Regime Assessment
    # ================================================================
    lines.append("---")
    lines.append("")
    lines.append("## 1. Current Regime Assessment")
    lines.append("")

    regime_label = regime.get("regime_label", "Unknown")
    confidence = regime.get("confidence", "unknown")
    transition = regime.get("transition_probability", {})

    zone_emoji = _zone_emoji(composite.get("zone_color", ""))

    lines.append("| Metric | Value |")
    lines.append("|--------|-------|")
    lines.append(f"| **Current Regime** | **{regime_label}** |")
    lines.append(f"| **Classification Confidence** | {confidence.upper()} |")
    lines.append(f"| **Transition Score** | {zone_emoji} **{score}/100** |")
    lines.append(f"| **Signal Zone** | {zone} |")
    lines.append(
        f"| **Transition Probability** | {transition.get('probability_range', 'N/A')} ({transition.get('level', 'N/A')}) |"
    )
    lines.append(f"| **Components Signaling** | {composite.get('signaling_components', 0)}/6 |")
    dq = composite.get("data_quality", {})
    if dq:
        lines.append(f"| **Data Quality** | {dq.get('label', 'N/A')} |")
    if transition.get("ambiguous"):
        lines.append(
            "| **Destination Clarity** | **AMBIGUOUS** - Multiple regimes show similar evidence |"
        )
    tied = regime.get("tied_regimes")
    if tied:
        lines.append(f"| **Competing Regimes** | {' vs '.join(r.capitalize() for r in tied)} |")
    lines.append("")

    lines.append(
        "> *Classification Confidence* measures how certain we are about the current regime"
    )
    lines.append("> classification (separate from *Transition Probability* shown above).")
    lines.append("> *Destination Clarity* (shown when ambiguous) indicates how clearly the")
    lines.append("> destination regime can be identified.")
    lines.append("")

    # Regime description
    lines.append(f"> **Regime:** {regime.get('regime_description', '')}")
    lines.append("")
    lines.append(f"> **Guidance:** {composite.get('guidance', '')}")

    # Transition direction
    from_r = transition.get("from_regime")
    to_r = transition.get("to_regime")
    if from_r and to_r:
        lines.append(
            f"> **Transition Direction:** {from_r.capitalize()} \u2192 {to_r.capitalize()}"
        )
    lines.append("")

    # ================================================================
    # Section 2: Transition Signal Dashboard
    # ================================================================
    lines.append("---")
    lines.append("")
    lines.append("## 2. Transition Signal Dashboard")
    lines.append("")
    lines.append(
        "| # | Component | Weight | Score | Direction | Fit | Crossover | Momentum (3M ROC) |"
    )
    lines.append(
        "|---|-----------|--------|-------|-----------|----|-----------|--------------------| "
    )

    component_order = [
        "concentration",
        "yield_curve",
        "credit_conditions",
        "size_factor",
        "equity_bond",
        "sector_rotation",
    ]

    consistency = regime.get("consistency", {})

    for i, key in enumerate(component_order, 1):
        comp_score = composite.get("component_scores", {}).get(key, {})
        comp_detail = components.get(key, {})
        score_val = comp_score.get("score", 0)
        weight_pct = f"{comp_score.get('weight', 0) * 100:.0f}%"
        direction = comp_detail.get("direction", "N/A")
        mom_qual = comp_detail.get("momentum_qualifier", "")
        if mom_qual and mom_qual != "N/A":
            direction = f"{direction} ({mom_qual})"
        crossover = comp_detail.get("crossover", {})
        cross_type = crossover.get("type", "none")
        cross_ago = crossover.get("bars_ago")
        roc_3m = comp_detail.get("roc_3m")

        bar = _score_bar(score_val)
        cross_str = cross_type.replace("_", " ")
        if cross_ago is not None:
            cross_str += f" ({cross_ago}mo ago)"
        roc_str = f"{roc_3m:+.2f}%" if roc_3m is not None else "N/A"

        fit = consistency.get(key, "--")
        fit_str = "OK" if fit == "consistent" else "CONTRA" if fit == "contradicting" else "--"

        lines.append(
            f"| {i} | **{comp_score.get('label', key)}** | {weight_pct} | "
            f"{bar} {score_val} | {direction} | {fit_str} | {cross_str} | {roc_str} |"
        )

    lines.append("")
    lines.append(
        f"**Strongest Signal:** {composite.get('strongest_signal', {}).get('label', 'N/A')} "
        f"({composite.get('strongest_signal', {}).get('score', 0)}/100)"
    )
    lines.append(
        f"**Weakest Signal:** {composite.get('weakest_signal', {}).get('label', 'N/A')} "
        f"({composite.get('weakest_signal', {}).get('score', 0)}/100)"
    )
    lines.append("")

    # ================================================================
    # Section 3: Component Details
    # ================================================================
    lines.append("---")
    lines.append("")
    lines.append("## 3. Component Details")
    lines.append("")

    for i, key in enumerate(component_order, 1):
        comp = components.get(key, {})
        comp_label = composite.get("component_scores", {}).get(key, {}).get("label", key)
        lines.append(f"### {i}. {comp_label}")
        lines.append("")

        if not comp.get("data_available", False):
            lines.append(f"- **Status:** {comp.get('signal', 'No data')}")
            lines.append("")
            continue

        # Common fields
        if "current_ratio" in comp and comp["current_ratio"] is not None:
            lines.append(f"- **Current Ratio:** {comp['current_ratio']}")
        if "current_spread" in comp and comp["current_spread"] is not None:
            lines.append(f"- **Current Spread:** {comp['current_spread']:+.3f}%")
        if comp.get("current_date"):
            lines.append(f"- **As Of:** {comp['current_date']}")
        if comp.get("sma_6m") is not None:
            lines.append(f"- **6M SMA:** {comp['sma_6m']}")
        if comp.get("sma_12m") is not None:
            lines.append(f"- **12M SMA:** {comp['sma_12m']}")
        if comp.get("roc_3m") is not None:
            lines.append(f"- **3M ROC:** {comp['roc_3m']:+.2f}%")
        if comp.get("roc_12m") is not None:
            lines.append(f"- **12M ROC:** {comp['roc_12m']:+.2f}%")
        if comp.get("percentile") is not None:
            lines.append(f"- **Percentile:** {comp['percentile']:.1f}%")

        # Component-specific fields
        if key == "yield_curve":
            if comp.get("steepening_type"):
                steep_labels = {
                    "bull_steepener": "Bull (short-end led: 2Y rates declining)",
                    "bear_steepener": "Bear (long-end led: 10Y rates rising)",
                    "mixed_steepener": "Mixed (both ends moving)",
                }
                steep_label = steep_labels.get(comp["steepening_type"], comp["steepening_type"])
                lines.append(f"- **Steepening Type:** {steep_label}")
            if comp.get("curve_state"):
                lines.append(f"- **Curve State:** {comp['curve_state']}")
            if comp.get("current_10y") is not None:
                lines.append(f"- **10Y Rate:** {comp['current_10y']}%")
            if comp.get("current_2y") is not None:
                lines.append(f"- **2Y Rate:** {comp['current_2y']}%")
            if comp.get("data_source"):
                lines.append(f"- **Data Source:** {comp['data_source']}")
            if comp.get("data_source") == "shy_tlt_proxy":
                lines.append("")
                lines.append(
                    "> **Warning:** Yield curve analysis uses SHY/TLT price ratio as proxy "
                    "(Treasury API 10Y-2Y spread unavailable). This has reduced resolution "
                    "for interest rate cycle detection. Interpret with caution."
                )

        if key == "equity_bond":
            if comp.get("correlation_6m") is not None:
                lines.append(f"- **6M Correlation:** {comp['correlation_6m']}")
            if comp.get("correlation_12m") is not None:
                lines.append(f"- **12M Correlation:** {comp['correlation_12m']}")
            if comp.get("correlation_regime"):
                lines.append(f"- **Correlation Regime:** {comp['correlation_regime']}")

        lines.append(f"- **Signal:** {comp.get('signal', 'N/A')}")
        lines.append("")

    # ================================================================
    # Section 4: Regime Classification Evidence
    # ================================================================
    lines.append("---")
    lines.append("")
    lines.append("## 4. Regime Classification Evidence")
    lines.append("")

    # Regime scores table
    regime_scores = regime.get("regime_scores", {})
    if regime_scores:
        lines.append("| Regime | Evidence Score | Match |")
        lines.append("|--------|--------------|-------|")
        current = regime.get("current_regime", "")
        for r_name in [
            "concentration",
            "broadening",
            "contraction",
            "inflationary",
            "transitional",
        ]:
            r_score = regime_scores.get(r_name, 0)
            marker = " **CURRENT**" if r_name == current else ""
            lines.append(f"| {r_name.capitalize()} | {r_score} |{marker} |")
        lines.append("")

    # Evidence list
    evidence = regime.get("evidence", [])
    if evidence:
        lines.append("**Key Signals:**")
        lines.append("")
        for ev in evidence:
            lines.append(
                f"- **{ev['component']}** (score {ev['score']}): {ev['direction']} - {ev['signal']}"
            )
        lines.append("")

    if transition.get("ambiguous"):
        lines.append(
            "> **Note:** Regime classification is ambiguous. Multiple regimes show "
            "similar evidence scores. This often indicates a transitional period."
        )
        lines.append("")

    # ================================================================
    # Section 5: Portfolio Posture Recommendations
    # ================================================================
    lines.append("---")
    lines.append("")
    lines.append("## 5. Portfolio Posture Recommendations")
    lines.append("")
    lines.append(f"**Current Regime:** {regime_label}")
    lines.append(f"**Recommended Posture:** {regime.get('portfolio_posture', 'N/A')}")
    lines.append("")

    # Competing regime posture (when ambiguous)
    tied = regime.get("tied_regimes")
    if tied and len(tied) >= 2:
        from scorer import REGIME_DESCRIPTIONS

        other_regime = tied[1] if tied[0] == regime.get("current_regime") else tied[0]
        other_info = REGIME_DESCRIPTIONS.get(other_regime, {})
        other_posture = other_info.get("portfolio_posture", "")
        if other_posture:
            lines.append(
                f"**Competing Regime ({other_regime.capitalize()}) Posture:** {other_posture}"
            )
            lines.append("")
            lines.append(
                "> **Note:** Regime classification is ambiguous. The recommended posture above "
                "may conflict with the competing regime's posture. Consider a blended approach "
                "(e.g., barbell strategy) that hedges against both scenarios."
            )
            lines.append("")

    # Duration warning when contraction + inflationary signals co-exist
    tied = regime.get("tied_regimes")
    if tied and "inflationary" in tied:
        lines.append("> **Duration Warning:** Contraction and Inflationary signals are both")
        lines.append("> present. Long-duration Treasuries may not provide effective hedging")
        lines.append("> when stock-bond correlation is positive. Prefer short-duration")
        lines.append("> Treasuries + TIPS until correlation regime shifts to negative.")
        lines.append("")

        eb = components.get("equity_bond", {})
        corr_regime = eb.get("correlation_regime", "unknown")
        yc = components.get("yield_curve", {})
        steep_type = yc.get("steepening_type")

        lines.append("**Duration Conditional Recommendations:**")
        lines.append("")
        if corr_regime == "positive":
            lines.append("- Correlation regime is **positive** -> short-duration Treasuries + TIPS")
        elif corr_regime == "negative":
            if steep_type == "bull_steepener":
                lines.append(
                    "- Correlation regime is **negative** and steepening is **bull steepener** "
                    "(short-end led) -> duration extension OK"
                )
            elif steep_type == "bear_steepener":
                lines.append(
                    "- Correlation regime is **negative** and steepening is **bear steepener** "
                    "(long-end led) -> cautious, TIPS preferred"
                )
            else:
                lines.append(
                    "- Correlation regime is **negative** -> duration extension possible, "
                    "monitor steepening type"
                )
        else:
            lines.append("- Correlation regime is **unknown** -> default to short-duration + TIPS")
        lines.append("")

    # Actions from zone
    actions = composite.get("actions", [])
    if actions:
        lines.append("**Action Items:**")
        lines.append("")
        for action in actions:
            lines.append(f"- {action}")
        lines.append("")

    # Confirmation and invalidation conditions
    lines.append("**Confirmation Conditions:**")
    lines.append("")
    lines.append("- 3+ components maintaining signal strength above 40 for 2+ months")
    lines.append("- Crossover confirmation in primary indicators (RSP/SPY, IWM/SPY)")
    lines.append("- Credit conditions (HYG/LQD) consistent with regime hypothesis")
    lines.append("")

    lines.append("**Invalidation Conditions:**")
    lines.append("")
    lines.append("- Signal reversal in 2+ primary components within 1 month")
    lines.append("- Composite score dropping below 20 (return to stable)")
    lines.append("- Credit conditions sharply contradicting regime thesis")
    lines.append("")

    # Transition triggers (only when ambiguous/transitional/tied)
    _add_transition_triggers(lines, regime, components)

    # ================================================================
    # Methodology
    # ================================================================
    lines.append("---")
    lines.append("")
    lines.append("## Methodology")
    lines.append("")
    lines.append(
        "This analysis uses **monthly-frequency cross-asset ratio analysis** to detect "
        "structural regime transitions over 1-2 year horizons."
    )
    lines.append("")
    lines.append("**6 Components** (each scored 0-100 for transition signal strength):")
    lines.append("")
    lines.append(
        "1. **Market Concentration** (25%): RSP/SPY ratio - mega-cap concentration vs broadening"
    )
    lines.append("2. **Yield Curve** (20%): 10Y-2Y spread - interest rate cycle transitions")
    lines.append("3. **Credit Conditions** (15%): HYG/LQD ratio - credit cycle risk appetite")
    lines.append("4. **Size Factor** (15%): IWM/SPY ratio - small vs large cap rotation")
    lines.append("5. **Equity-Bond** (15%): SPY/TLT ratio + correlation - stock-bond regime")
    lines.append("6. **Sector Rotation** (10%): XLY/XLP ratio - cyclical vs defensive appetite")
    lines.append("")
    lines.append("**Transition Detection** uses a 3-layer approach:")
    lines.append("")
    lines.append("1. MA Crossover: 6-month vs 12-month SMA crossover on each ratio")
    lines.append("2. Momentum Shift: 3-month ROC reversing against 12-month trend")
    lines.append("3. Cross-Component: Multiple components signaling simultaneously")
    lines.append("")
    lines.append(
        "**5 Regime Classifications:** Concentration, Broadening, Contraction, Inflationary, Transitional"
    )
    lines.append("")
    lines.append("For detailed methodology, see `references/regime_detection_methodology.md`.")
    lines.append("")

    # Disclaimer
    lines.append("---")
    lines.append("")
    lines.append(
        "**Disclaimer:** This analysis is for educational and informational purposes only. "
        "Not investment advice. Regime detection is inherently uncertain and signals may "
        "produce false positives. Past regime patterns may not predict future transitions. "
        "Conduct your own research and consult a financial advisor before making "
        "investment decisions."
    )
    lines.append("")

    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Markdown report saved to: {output_file}")


def _zone_emoji(color: str) -> str:
    mapping = {
        "green": "🟢",
        "yellow": "🟡",
        "orange": "🟠",
        "red": "🔴",
        "critical": "⚫",
    }
    return mapping.get(color, "⚪")


def _score_bar(score: int) -> str:
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


def _add_transition_triggers(lines, regime, components):
    """Generate regime-specific trigger conditions from current component state."""
    tied = regime.get("tied_regimes")
    if not tied and regime.get("current_regime") != "transitional":
        return

    lines.append("### Regime Transition Triggers")
    lines.append("")

    credit_dir = components.get("credit_conditions", {}).get("direction", "unknown")
    sector_dir = components.get("sector_rotation", {}).get("direction", "unknown")
    yc = components.get("yield_curve", {})
    steep_type = yc.get("steepening_type")

    lines.append("**Contraction strengthens if:**")
    if credit_dir != "tightening":
        lines.append("- Credit (HYG/LQD) shifts to tightening")
    else:
        lines.append("- Credit (HYG/LQD) tightening continues")
    if sector_dir != "risk_off":
        lines.append("- Sector rotation (XLY/XLP) turns risk-off")
    else:
        lines.append("- Sector rotation (XLY/XLP) risk-off accelerates")
    lines.append("")

    lines.append("**Recovery (Broadening) signal if:**")
    lines.append("- Credit (HYG/LQD) turns to easing")
    lines.append("- Sector rotation (XLY/XLP) turns risk-on")
    lines.append("- Concentration (RSP/SPY) shifts to broadening")
    lines.append("")

    lines.append("**Inflationary regime confirms if:**")
    lines.append("- Stock-bond correlation stays positive")
    if steep_type:
        lines.append("- Yield curve steepening remains bear-type (long-end led)")
    else:
        lines.append("- Long-term yields continue rising")
    lines.append("")

    lines.append("**Duration extension OK when:**")
    lines.append("- Stock-bond correlation turns negative")
    lines.append("- Yield curve shows bull steepener (short-end led)")
    lines.append("")
