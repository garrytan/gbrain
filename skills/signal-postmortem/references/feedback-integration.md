# Feedback Integration Guide

## Overview

This document explains how signal postmortem results integrate with downstream systems: edge-signal-aggregator weight calibration and the skill improvement backlog.

## Feedback Targets

### 1. Edge-Signal-Aggregator Weight Calibration

**Purpose**: Adjust the weight of each contributing skill based on historical accuracy.

**Integration Point**: `reports/weight_feedback_YYYY-MM-DD.json`

**Consumption**:
1. edge-signal-aggregator reads feedback file on startup
2. Applies weight adjustments to skill contribution scores
3. Logs adjustment application for audit trail

**Weight Adjustment Formula**:

```
new_weight = current_weight * (1 + adjustment_factor)

adjustment_factor = (accuracy - baseline) * sensitivity

where:
- accuracy = true_positives / (true_positives + false_positives)
- baseline = 0.55 (expected random accuracy)
- sensitivity = 0.5 (dampening factor to avoid overreaction)
```

**Constraints**:
- Minimum weight: 0.3 (never fully disable a skill)
- Maximum weight: 2.0 (never over-amplify)
- Minimum sample size: 20 signals for adjustment
- Rolling window: 90 days of postmortem data

### 2. Skill Improvement Backlog

**Purpose**: Generate actionable improvement tasks for the skill improvement loop.

**Integration Point**: `reports/skill_improvement_backlog.yaml`

**Consumption**:
1. Skill improvement loop reads backlog entries
2. Prioritizes by severity and sample size
3. Creates improvement branches for high-severity issues

**Issue Types**:

| Issue Type | Trigger | Severity |
|------------|---------|----------|
| `false_positive_cluster` | >15% FP rate with 20+ samples | MEDIUM-HIGH |
| `regime_sensitivity` | >25% regime mismatch rate | MEDIUM |
| `sector_blind_spot` | >20% FP rate in specific sector | MEDIUM |
| `timing_drift` | Accuracy degraded >10% over 30 days | LOW-MEDIUM |
| `overconfidence` | High-confidence signals underperforming | HIGH |

**Backlog Entry Format**:

```yaml
- skill: vcp-screener
  issue_type: false_positive_cluster
  severity: medium
  evidence:
    false_positive_rate: 0.18
    sample_size: 45
    regime_correlation: RISK_OFF
    sector_correlation: Technology
  suggested_action: "Add RISK_OFF regime filter or reduce confidence"
  priority_score: 72  # Calculated from severity * sample_size * impact
  generated_by: signal-postmortem
  generated_at: "2026-03-17T10:35:00Z"
  status: pending
```

## Feedback Frequency

### Real-Time (Per Signal)

- Postmortem record created immediately after trade closure
- Stored in `reports/postmortems/`

### Daily Batch

- Weight feedback regenerated daily at 06:00
- Improvement backlog updated with new entries
- Old entries marked as `addressed` when improvements deployed

### Weekly Review

- Summary statistics by skill, sector, regime
- Trend analysis (rolling 4-week accuracy)
- Human review flagged for significant changes

## Data Flow Diagram

```
Signal Generated
       |
       v
Trade Executed (or skipped)
       |
       v
Holding Period Completes
       |
       v
postmortem_recorder.py
       |
       +---> postmortem record (JSON)
       |
       v
postmortem_analyzer.py
       |
       +---> weight_feedback.json --> edge-signal-aggregator
       |
       +---> skill_improvement_backlog.yaml --> skill improvement loop
       |
       +---> summary report (Markdown)
```

## Idempotency and Deduplication

### Postmortem Records

- `postmortem_id` = `pm_` + `signal_id`
- If postmortem already exists, update instead of duplicate
- Version field tracks updates

### Weight Feedback

- Regenerated fresh each run (not cumulative)
- Based on rolling 90-day window
- Old feedback files archived to `reports/archive/`

### Backlog Entries

- Keyed by `skill` + `issue_type` + `month`
- New evidence updates existing entry instead of creating duplicate
- Entry moved to `addressed` when skill version changes

## Minimum Thresholds

To avoid noisy feedback from small samples:

| Metric | Minimum |
|--------|---------|
| Weight adjustment | 20 signals |
| Backlog entry | 15 signals |
| Summary statistics | 10 signals |
| Regime correlation | 10 signals per regime |

## Manual Override Integration

When human review identifies an issue not caught by automated analysis:

```yaml
# Manual backlog entry
- skill: earnings-trade-analyzer
  issue_type: manual_review
  severity: high
  evidence:
    description: "Systematic gap fade failure in biotech earnings"
    reviewer: "tradermonty"
  suggested_action: "Exclude biotech from gap fade signals"
  generated_by: human_review
  generated_at: "2026-03-17T14:00:00Z"
```

Manual entries have `generated_by: human_review` and are prioritized higher.

## Conflict Resolution

When automated and manual feedback conflict:

1. Manual feedback takes precedence for immediate action
2. Automated feedback triggers investigation
3. Resolution documented in backlog entry

## Audit Trail

All feedback actions are logged:

```json
{
  "action": "weight_adjustment_applied",
  "skill": "vcp-screener",
  "old_weight": 1.0,
  "new_weight": 0.85,
  "reason": "15% FP rate in RISK_OFF",
  "applied_at": "2026-03-17T06:00:00Z",
  "applied_by": "edge-signal-aggregator"
}
```

Logs stored in `logs/feedback_audit.log` with 90-day retention.
