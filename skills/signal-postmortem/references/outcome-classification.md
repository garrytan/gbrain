# Outcome Classification Guide

## Overview

This document defines how signal outcomes are classified in the postmortem process. Accurate classification is essential for meaningful feedback to edge-signal-aggregator and skill improvement.

## Classification Categories

### 1. TRUE_POSITIVE

**Definition**: The predicted direction matched the realized return sign.

**Criteria**:
- LONG signal with positive realized return at holding period
- SHORT signal with negative realized return at holding period
- Minimum threshold: |return| >= 0.5% to avoid noise classification

**Examples**:
- Signal: LONG AAPL at $170, predicted 5-day upside
- Outcome: AAPL at $175 after 5 days (+2.9%)
- Classification: TRUE_POSITIVE

### 2. FALSE_POSITIVE

**Definition**: The predicted direction was opposite to the realized return.

**Criteria**:
- LONG signal with negative realized return at holding period
- SHORT signal with positive realized return at holding period
- Minimum threshold: |return| >= 0.5% to avoid noise classification

**Sub-categories**:
- `FALSE_POSITIVE_MILD`: -0.5% to -2% for LONG (or +0.5% to +2% for SHORT)
- `FALSE_POSITIVE_SEVERE`: worse than -2% for LONG (or +2% for SHORT)

**Examples**:
- Signal: LONG NVDA at $900, predicted breakout
- Outcome: NVDA at $870 after 5 days (-3.3%)
- Classification: FALSE_POSITIVE_SEVERE

### 3. MISSED_OPPORTUNITY

**Definition**: A signal that was generated but not acted upon, and would have been profitable.

**Use Cases**:
- Signals filtered out by aggregator confidence threshold
- Signals skipped due to position sizing constraints
- Signals in watchlist but not traded

**Criteria**:
- Signal was generated but `trade_taken = false`
- Realized return in predicted direction >= 2%

**Note**: This category helps identify overly conservative filtering.

### 4. REGIME_MISMATCH

**Definition**: Signal failed primarily due to a market regime change rather than skill error.

**Criteria**:
- `regime_at_signal` differs from `regime_at_exit`
- AND return in opposite direction of prediction
- Regime change must be documented (e.g., VIX spike, Fed announcement)

**Examples**:
- Signal: LONG growth stock on 2026-03-05 (RISK_ON regime)
- Outcome: Tariff announcement on 2026-03-07 triggered RISK_OFF
- Result: Stock down 8% due to sector rotation
- Classification: REGIME_MISMATCH (not FALSE_POSITIVE)

**Regime Detection**:
- RISK_ON: VIX < 20, breadth > 60%, leading stocks advancing
- RISK_OFF: VIX > 25, breadth < 40%, defensive rotation
- TRANSITION: Mixed signals, high uncertainty

## Edge Cases

### Flat Outcome (|return| < 0.5%)

- Classification: `NEUTRAL`
- Does not count as TRUE_POSITIVE or FALSE_POSITIVE
- May indicate weak signal strength

### Early Exit

When a trade is closed before the target holding period:

```
holding_period_actual < holding_period_target
```

- Use actual holding period for return calculation
- Note `early_exit = true` in postmortem record
- Include `early_exit_reason`: stop_loss, target_reached, discretionary

### Gap Events

If the stock gapped significantly at open due to overnight news:

- Record `gap_event = true`
- Include `gap_pct` in postmortem
- Consider separate analysis for gap-driven outcomes

### Multiple Holding Periods

The skill tracks both 5-day and 20-day returns:

| Metric | 5-Day | 20-Day |
|--------|-------|--------|
| Purpose | Short-term edge validation | Medium-term edge validation |
| Threshold | 0.5% | 1.0% |
| Weight for feedback | 60% | 40% |

A signal can be TRUE_POSITIVE at 5 days but FALSE_POSITIVE at 20 days (or vice versa). Both are recorded.

## Classification Decision Tree

```
1. Was the trade taken?
   NO  -> If would have been profitable: MISSED_OPPORTUNITY
         Otherwise: SKIPPED (no postmortem needed)
   YES -> Continue

2. Did regime change during holding period?
   YES -> Is return in wrong direction AND > 2% loss?
          YES -> REGIME_MISMATCH
          NO  -> Continue
   NO  -> Continue

3. Is |return| < 0.5%?
   YES -> NEUTRAL
   NO  -> Continue

4. Does return sign match predicted direction?
   YES -> TRUE_POSITIVE
   NO  -> FALSE_POSITIVE (check severity)
```

## Attribution Rules

### Single-Source Signals

When a signal comes from one skill (e.g., vcp-screener alone):
- Full attribution to that skill

### Aggregated Signals

When a signal comes from edge-signal-aggregator combining multiple skills:
- Attribution proportional to each skill's contribution weight
- Example: VCP (0.4) + CANSLIM (0.3) + Breadth (0.3)
- If FALSE_POSITIVE: each skill receives proportional negative feedback

### Override Signals

When a human overrides a skill recommendation:
- Record `human_override = true`
- Separate analysis track for human decision quality

## Confidence Adjustment Factors

Classification confidence is adjusted based on:

| Factor | Adjustment |
|--------|------------|
| High volume day | +10% confidence |
| Low volume day | -10% confidence |
| Earnings during holding period | -20% confidence |
| VIX spike > 5 points | -15% confidence |
| Large gap (> 3%) | -15% confidence |

Final confidence is capped at [0.5, 1.0] range.
