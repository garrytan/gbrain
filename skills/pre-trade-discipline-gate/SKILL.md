---
name: pre-trade-discipline-gate
description: Evaluate a local pre-trade checklist before manual order entry, blocking planless, oversized, revenge-risk, market-regime-blocked, or circuit-breaker-blocked entries while journaling the decision for trader-memory-core review.
---

# Pre-Trade Discipline Gate

## Overview

Evaluate whether a planned manual order should proceed before it is placed at the broker. This skill reads a local checklist plus optional market-regime, circuit-breaker, and trader-memory-core artifacts. It produces a `pre_trade_discipline_decision` artifact and can link that artifact back to the related thesis without changing the thesis review schedule.

The gate is intentionally offline. It does not place orders, cancel orders, call a broker API, or fetch market data.

## When to Use

- Immediately before placing any manual entry order
- When a candidate has passed chart validation and position sizing
- After a recent loss, to avoid revenge trades during the cooldown window
- When the workflow has an upstream `exposure_decision` and `circuit_breaker_decision`
- When you want checklist adherence to be visible in later trader-memory-core reviews

## Prerequisites

- Python 3.9+
- A local JSON or YAML answers file with candidate-level checklist answers
- Optional trader-memory-core thesis state under `state/theses/`
- Optional `exposure_decision` JSON from market-regime-daily / exposure-coach
- Optional `circuit_breaker_decision` JSON from drawdown-circuit-breaker

## Workflow

### Step 1: Prepare the Checklist

Create a JSON or YAML file with candidate answers. Only actionable manual-order intents are gated. Watchlist and ignore intents are journaled as `NO_ACTIONABLE_ORDERS`.

```json
{
  "candidates": [
    {
      "symbol": "AAPL",
      "thesis_id": "th_aapl_gm_20260703_0001",
      "order_intent": "ENTRY_READY",
      "entry_in_written_plan": true,
      "stop_predefined": true,
      "size_within_plan": true,
      "planned_risk_dollars": 500,
      "actual_risk_dollars": 500,
      "notes": "Entry matches the journaled breakout plan."
    }
  ]
}
```

Actionable intents are `ENTRY_READY`, `ACTIONABLE`, `ACTIONABLE_DAY1`, and `MANUAL_ORDER`. Non-actionable intents such as `WATCHLIST`, `DELAYED_EP_WATCH`, `PEAD_HANDOFF`, `IGNORE`, and `REJECTED` are recorded but do not create an order permission.

### Step 2: Run the Gate

```bash
python3 skills/pre-trade-discipline-gate/scripts/check_pre_trade_discipline.py \
  --answers-file state/manual-entry-checklist.json \
  --state-dir state/theses \
  --market-regime-decision reports/exposure_decision_latest.json \
  --circuit-breaker-decision reports/circuit_breaker_decision_latest.json \
  --output-dir reports/pre-trade-discipline \
  --journal-dir state/journal/pre-trade-discipline
```

Set `--as-of` for deterministic testing or backfills:

```bash
python3 skills/pre-trade-discipline-gate/scripts/check_pre_trade_discipline.py \
  --answers-file state/manual-entry-checklist.json \
  --as-of 2026-07-03T12:00:00-04:00
```

### Step 3: Interpret the Decision

| Decision | Meaning |
|---|---|
| `GO` | All actionable manual-order candidates passed the checklist and upstream gates |
| `REVIEW_REQUIRED` | Inputs are missing, unknown, or journaling failed; do not place orders until reviewed |
| `NO_GO` | At least one actionable candidate violated a discipline rule |
| `NO_ACTIONABLE_ORDERS` | The file contains no actionable manual orders; nothing should be placed |

By default the CLI exits `0` for every valid decision and exits `1` only for input or runtime errors. Use `--fail-on-non-go` when a shell pipeline should return `2` for any non-`GO` decision.

## Rules

The gate blocks an actionable candidate when:

- The entry is not confirmed in the written plan
- The stop is not predefined
- The size is not confirmed within plan
- `actual_risk_dollars` exceeds `planned_risk_dollars`
- trader-memory-core has a losing exit or partial loss inside the revenge window
- exposure-coach recommendation is `REDUCE_ONLY` or `CASH_PRIORITY`
- drawdown-circuit-breaker recommendation is `COOLDOWN`, `HALTED`, or `TRADING_HALTED`

Missing or unreadable market-regime or circuit-breaker artifacts produce `REVIEW_REQUIRED` for actionable orders. If no actionable order exists, the result remains `NO_ACTIONABLE_ORDERS`.

## Output Formats

The script writes:

- `pre_trade_discipline_decision_YYYY-MM-DD_HHMMSS.json`
- A matching markdown report unless `--json-only` is set
- A JSONL journal row under `state/journal/pre-trade-discipline/` when `--journal-dir` is provided

Each candidate result includes a `checklist_answers` object with the written-plan, stop, size, risk-dollar, and notes answers used for the decision, so later reviews can audit what was answered at order time.

If a candidate includes `thesis_id` and `--state-dir` is provided, the JSON report is linked into the thesis `linked_reports` list using trader-memory-core `link_report`. The skill does not call `mark_reviewed` and does not change monitoring review dates.

## Resources

- `scripts/check_pre_trade_discipline.py` - Main CLI and rule engine
- `references/discipline_gate_framework.md` - Rule definitions and integration notes
- `skills/trader-memory-core/schemas/thesis.schema.json` - Thesis state schema

## Key Principles

1. **Manual execution only** - The output is a pre-broker checklist gate, not an order router.
2. **Written plan first** - No written entry plan, stop, or size confirmation means no manual entry.
3. **Producer-compatible state reading** - Revenge-risk detection follows trader-memory-core timestamp and outcome behavior.
4. **Journal without review side effects** - The gate links reports to theses without advancing review schedules.

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
