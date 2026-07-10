#!/usr/bin/env python3
"""
Signal Postmortem Analyzer

Generates feedback for edge-signal-aggregator weight calibration
and skill improvement backlog entries from postmortem records.
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


def load_postmortems(postmortems_dir: str, days_back: int = 90) -> list:
    """
    Load postmortem records from directory.

    Args:
        postmortems_dir: Directory containing postmortem JSON files
        days_back: Only include postmortems from this many days back

    Returns:
        List of postmortem records
    """
    postmortems = []
    dir_path = Path(postmortems_dir)

    if not dir_path.exists():
        return postmortems

    cutoff_date = datetime.now() - timedelta(days=days_back)

    for json_file in dir_path.glob("pm_*.json"):
        try:
            with open(json_file) as f:
                pm = json.load(f)

            # Check date
            recorded_at = pm.get("recorded_at", "")
            if recorded_at:
                try:
                    rec_dt = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
                    if rec_dt.replace(tzinfo=None) < cutoff_date:
                        continue
                except ValueError:
                    pass

            postmortems.append(pm)
        except (OSError, json.JSONDecodeError) as e:
            print(f"Warning: Error loading {json_file}: {e}", file=sys.stderr)

    return postmortems


def calculate_skill_metrics(postmortems: list) -> dict:
    """
    Calculate accuracy and other metrics by source skill.

    Returns dict mapping skill name to metrics.
    """
    skill_data = defaultdict(
        lambda: {
            "true_positive": 0,
            "false_positive": 0,
            "false_positive_severe": 0,
            "regime_mismatch": 0,
            "neutral": 0,
            "total": 0,
            "total_return_5d": 0.0,
            "returns": [],
        }
    )

    for pm in postmortems:
        skill = pm.get("source_skill", "unknown")
        outcome = pm.get("outcome_category", "UNKNOWN")
        returns_5d = pm.get("realized_returns", {}).get("5d", 0.0)

        skill_data[skill]["total"] += 1
        skill_data[skill]["total_return_5d"] += returns_5d
        skill_data[skill]["returns"].append(returns_5d)

        if outcome == "TRUE_POSITIVE":
            skill_data[skill]["true_positive"] += 1
        elif outcome in ("FALSE_POSITIVE", "FALSE_POSITIVE_SEVERE"):
            skill_data[skill]["false_positive"] += 1
            if outcome == "FALSE_POSITIVE_SEVERE":
                skill_data[skill]["false_positive_severe"] += 1
        elif outcome == "REGIME_MISMATCH":
            skill_data[skill]["regime_mismatch"] += 1
        elif outcome == "NEUTRAL":
            skill_data[skill]["neutral"] += 1

    # Calculate derived metrics
    metrics = {}
    for skill, data in skill_data.items():
        total_decisions = data["true_positive"] + data["false_positive"]
        accuracy = data["true_positive"] / total_decisions if total_decisions > 0 else 0.0
        fp_rate = data["false_positive"] / data["total"] if data["total"] > 0 else 0.0
        avg_return = data["total_return_5d"] / data["total"] if data["total"] > 0 else 0.0

        metrics[skill] = {
            "sample_size": data["total"],
            "true_positive": data["true_positive"],
            "false_positive": data["false_positive"],
            "false_positive_severe": data["false_positive_severe"],
            "regime_mismatch": data["regime_mismatch"],
            "neutral": data["neutral"],
            "accuracy": accuracy,
            "false_positive_rate": fp_rate,
            "avg_return_5d": avg_return,
        }

    return metrics


def generate_weight_feedback(
    metrics: dict,
    min_sample_size: int = 20,
    baseline_accuracy: float = 0.55,
    sensitivity: float = 0.5,
) -> dict:
    """
    Generate weight adjustment suggestions for edge-signal-aggregator.
    """
    adjustments = []

    for skill, data in metrics.items():
        if data["sample_size"] < min_sample_size:
            continue

        accuracy = data["accuracy"]
        adjustment_factor = (accuracy - baseline_accuracy) * sensitivity

        # Clamp to reasonable range
        new_weight = max(0.3, min(2.0, 1.0 + adjustment_factor))

        # Only suggest if meaningful change
        if abs(1.0 - new_weight) >= 0.05:
            reason = []
            if data["false_positive_rate"] > 0.15:
                reason.append(f"{data['false_positive_rate']:.0%} false positive rate")
            if accuracy < baseline_accuracy:
                reason.append(
                    f"below baseline accuracy ({accuracy:.0%} vs {baseline_accuracy:.0%})"
                )
            if accuracy > 0.65:
                reason.append(f"strong accuracy ({accuracy:.0%})")

            adjustments.append(
                {
                    "skill": skill,
                    "current_weight": 1.0,
                    "suggested_weight": round(new_weight, 2),
                    "reason": "; ".join(reason) if reason else "accuracy-based adjustment",
                    "sample_size": data["sample_size"],
                    "accuracy": round(accuracy, 3),
                    "false_positive_rate": round(data["false_positive_rate"], 3),
                }
            )

    # Determine confidence based on total sample size
    total_samples = sum(m["sample_size"] for m in metrics.values())
    if total_samples >= 100:
        confidence = "HIGH"
    elif total_samples >= 50:
        confidence = "MEDIUM"
    else:
        confidence = "LOW"

    return {
        "schema_version": "1.0",
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "analysis_period": {"days_back": 90, "total_postmortems": total_samples},
        "skill_adjustments": adjustments,
        "confidence": confidence,
        "min_sample_threshold": min_sample_size,
    }


def generate_improvement_backlog(
    metrics: dict, postmortems: list, min_sample_size: int = 15
) -> list:
    """
    Generate skill improvement backlog entries.
    """
    entries = []
    now = datetime.utcnow().isoformat() + "Z"

    for skill, data in metrics.items():
        if data["sample_size"] < min_sample_size:
            continue

        # Check for false positive cluster
        if data["false_positive_rate"] > 0.15:
            # Analyze regime correlation
            regime_correlation = analyze_regime_correlation(postmortems, skill)

            severity = "high" if data["false_positive_rate"] > 0.25 else "medium"
            priority_score = int(data["false_positive_rate"] * data["sample_size"] * 100)

            entries.append(
                {
                    "skill": skill,
                    "issue_type": "false_positive_cluster",
                    "severity": severity,
                    "evidence": {
                        "false_positive_rate": round(data["false_positive_rate"], 3),
                        "sample_size": data["sample_size"],
                        "regime_correlation": regime_correlation,
                    },
                    "suggested_action": f"Add regime filter or reduce confidence in {regime_correlation} regime"
                    if regime_correlation != "NONE"
                    else "Review signal generation logic for systematic errors",
                    "priority_score": priority_score,
                    "generated_by": "signal-postmortem",
                    "generated_at": now,
                    "status": "pending",
                }
            )

        # Check for regime sensitivity
        regime_mismatch_rate = (
            data["regime_mismatch"] / data["sample_size"] if data["sample_size"] > 0 else 0
        )
        if regime_mismatch_rate > 0.25:
            entries.append(
                {
                    "skill": skill,
                    "issue_type": "regime_sensitivity",
                    "severity": "medium",
                    "evidence": {
                        "regime_mismatch_rate": round(regime_mismatch_rate, 3),
                        "sample_size": data["sample_size"],
                    },
                    "suggested_action": "Incorporate market regime detection into signal generation",
                    "priority_score": int(regime_mismatch_rate * data["sample_size"] * 80),
                    "generated_by": "signal-postmortem",
                    "generated_at": now,
                    "status": "pending",
                }
            )

        # Check for severe false positives (overconfidence)
        severe_fp_rate = (
            data["false_positive_severe"] / data["sample_size"] if data["sample_size"] > 0 else 0
        )
        if severe_fp_rate > 0.10:
            entries.append(
                {
                    "skill": skill,
                    "issue_type": "overconfidence",
                    "severity": "high",
                    "evidence": {
                        "severe_fp_rate": round(severe_fp_rate, 3),
                        "severe_fp_count": data["false_positive_severe"],
                        "sample_size": data["sample_size"],
                    },
                    "suggested_action": "Review confidence scoring; reduce position size or add confirmation filters",
                    "priority_score": int(severe_fp_rate * data["sample_size"] * 150),
                    "generated_by": "signal-postmortem",
                    "generated_at": now,
                    "status": "pending",
                }
            )

    # Sort by priority score descending
    entries.sort(key=lambda x: x["priority_score"], reverse=True)

    return entries


def analyze_regime_correlation(postmortems: list, skill: str) -> str:
    """
    Analyze which regime has the most false positives for a skill.
    """
    regime_fps = defaultdict(int)
    regime_totals = defaultdict(int)

    for pm in postmortems:
        if pm.get("source_skill") != skill:
            continue

        regime = pm.get("regime_at_signal", "UNKNOWN")
        regime_totals[regime] += 1

        if pm.get("outcome_category", "").startswith("FALSE_POSITIVE"):
            regime_fps[regime] += 1

    # Find regime with highest FP rate
    worst_regime = "NONE"
    worst_rate = 0.0

    for regime, total in regime_totals.items():
        if total < 5:  # Minimum for correlation
            continue
        rate = regime_fps[regime] / total
        if rate > worst_rate and rate > 0.2:  # Threshold for correlation
            worst_rate = rate
            worst_regime = regime

    return worst_regime


def generate_summary(metrics: dict, postmortems: list, group_by: list) -> str:
    """
    Generate markdown summary report.
    """
    lines = [
        "# Signal Postmortem Summary",
        "",
        f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"**Total Postmortems:** {len(postmortems)}",
        "",
    ]

    # Overall statistics
    total_tp = sum(m["true_positive"] for m in metrics.values())
    total_fp = sum(m["false_positive"] for m in metrics.values())
    total_all = sum(m["sample_size"] for m in metrics.values())

    overall_accuracy = total_tp / (total_tp + total_fp) if (total_tp + total_fp) > 0 else 0

    lines.extend(
        [
            "## Overall Statistics",
            "",
            "| Metric | Value |",
            "|--------|-------|",
            f"| Total Signals | {total_all} |",
            f"| True Positives | {total_tp} |",
            f"| False Positives | {total_fp} |",
            f"| Overall Accuracy | {overall_accuracy:.1%} |",
            "",
        ]
    )

    # By skill breakdown
    if "skill" in group_by:
        lines.extend(
            [
                "## By Skill",
                "",
                "| Skill | Samples | Accuracy | FP Rate | Avg Return (5d) |",
                "|-------|---------|----------|---------|-----------------|",
            ]
        )

        for skill, data in sorted(metrics.items(), key=lambda x: x[1]["sample_size"], reverse=True):
            lines.append(
                f"| {skill} | {data['sample_size']} | {data['accuracy']:.1%} | {data['false_positive_rate']:.1%} | {data['avg_return_5d']:.2%} |"
            )

        lines.append("")

    # By month breakdown
    if "month" in group_by:
        monthly = defaultdict(lambda: {"tp": 0, "fp": 0, "total": 0})

        for pm in postmortems:
            signal_date = pm.get("signal_date", "")
            if not signal_date:
                continue

            month_key = signal_date[:7]  # YYYY-MM
            monthly[month_key]["total"] += 1

            outcome = pm.get("outcome_category", "")
            if outcome == "TRUE_POSITIVE":
                monthly[month_key]["tp"] += 1
            elif outcome.startswith("FALSE_POSITIVE"):
                monthly[month_key]["fp"] += 1

        lines.extend(
            [
                "## By Month",
                "",
                "| Month | Signals | Accuracy |",
                "|-------|---------|----------|",
            ]
        )

        for month, data in sorted(monthly.items()):
            decisions = data["tp"] + data["fp"]
            acc = data["tp"] / decisions if decisions > 0 else 0
            lines.append(f"| {month} | {data['total']} | {acc:.1%} |")

        lines.append("")

    # Outcome distribution
    outcome_dist = defaultdict(int)
    for pm in postmortems:
        outcome = pm.get("outcome_category", "UNKNOWN")
        outcome_dist[outcome] += 1

    lines.extend(
        [
            "## Outcome Distribution",
            "",
            "| Outcome | Count | Percentage |",
            "|---------|-------|------------|",
        ]
    )

    for outcome, count in sorted(outcome_dist.items(), key=lambda x: x[1], reverse=True):
        pct = count / len(postmortems) if postmortems else 0
        lines.append(f"| {outcome} | {count} | {pct:.1%} |")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Analyze postmortem records and generate feedback")
    parser.add_argument(
        "--postmortems-dir",
        default="reports/postmortems/",
        help="Directory containing postmortem JSON files (default: reports/postmortems/)",
    )
    parser.add_argument(
        "--days-back",
        type=int,
        default=90,
        help="Analyze postmortems from this many days back (default: 90)",
    )
    parser.add_argument(
        "--generate-weight-feedback",
        action="store_true",
        help="Generate weight adjustment suggestions for edge-signal-aggregator",
    )
    parser.add_argument(
        "--generate-improvement-backlog",
        action="store_true",
        help="Generate skill improvement backlog entries",
    )
    parser.add_argument("--summary", action="store_true", help="Generate summary statistics report")
    parser.add_argument(
        "--group-by",
        default="skill,month",
        help="Comma-separated grouping for summary (default: skill,month)",
    )
    parser.add_argument(
        "--min-sample-size",
        type=int,
        default=20,
        help="Minimum samples for weight feedback (default: 20)",
    )
    parser.add_argument(
        "--output-dir", default="reports/", help="Output directory (default: reports/)"
    )

    args = parser.parse_args()

    # Load postmortems
    postmortems = load_postmortems(args.postmortems_dir, args.days_back)

    if not postmortems:
        print(f"No postmortems found in {args.postmortems_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(postmortems)} postmortems")

    # Calculate metrics
    metrics = calculate_skill_metrics(postmortems)

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d")

    # Generate weight feedback
    if args.generate_weight_feedback:
        feedback = generate_weight_feedback(metrics, args.min_sample_size)
        output_file = output_dir / f"weight_feedback_{timestamp}.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(feedback, f, indent=2)
        print(f"Saved weight feedback: {output_file}")
        print(f"  Adjustments: {len(feedback['skill_adjustments'])}")
        print(f"  Confidence: {feedback['confidence']}")

    # Generate improvement backlog
    if args.generate_improvement_backlog:
        backlog = generate_improvement_backlog(metrics, postmortems, min(15, args.min_sample_size))
        output_file = output_dir / f"skill_improvement_backlog_{timestamp}.yaml"

        # Write as YAML-like format
        with open(output_file, "w", encoding="utf-8") as f:
            for entry in backlog:
                f.write(f"- skill: {entry['skill']}\n")
                f.write(f"  issue_type: {entry['issue_type']}\n")
                f.write(f"  severity: {entry['severity']}\n")
                f.write("  evidence:\n")
                for k, v in entry["evidence"].items():
                    f.write(f"    {k}: {v}\n")
                f.write(f'  suggested_action: "{entry["suggested_action"]}"\n')
                f.write(f"  priority_score: {entry['priority_score']}\n")
                f.write(f"  generated_by: {entry['generated_by']}\n")
                f.write(f'  generated_at: "{entry["generated_at"]}"\n')
                f.write(f"  status: {entry['status']}\n")
                f.write("\n")

        print(f"Saved improvement backlog: {output_file}")
        print(f"  Entries: {len(backlog)}")

    # Generate summary
    if args.summary:
        group_by = [g.strip() for g in args.group_by.split(",")]
        summary = generate_summary(metrics, postmortems, group_by)
        output_file = output_dir / f"postmortem_summary_{timestamp}.md"
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(summary)
        print(f"Saved summary: {output_file}")

    # Default: print metrics if no specific output requested
    if not (args.generate_weight_feedback or args.generate_improvement_backlog or args.summary):
        print("\nMetrics by skill:")
        for skill, data in sorted(metrics.items(), key=lambda x: x[1]["sample_size"], reverse=True):
            print(f"\n{skill}:")
            print(f"  Samples: {data['sample_size']}")
            print(f"  Accuracy: {data['accuracy']:.1%}")
            print(f"  FP Rate: {data['false_positive_rate']:.1%}")
            print(f"  Avg Return (5d): {data['avg_return_5d']:.2%}")


if __name__ == "__main__":
    main()
