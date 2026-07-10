# Pre-Trade Discipline Gate Framework

## Purpose

The pre-trade discipline gate sits after thesis registration and before any manual broker order. It is designed to stop planless, oversized, revenge-risk, or upstream-blocked entries while leaving watchlist decisions recordable.

The skill is advisory and journal-focused. It does not automate execution.

## Decision Model

Overall decisions are ranked:

1. `GO`
2. `NO_ACTIONABLE_ORDERS`
3. `REVIEW_REQUIRED`
4. `NO_GO`

`NO_GO` outranks `REVIEW_REQUIRED` so explicit rule violations are visible even when another candidate only needs review.

## Actionable Intents

Manual-order gate applies to:

- `ENTRY_READY`
- `ACTIONABLE`
- `ACTIONABLE_DAY1`
- `MANUAL_ORDER`

The following intents are journaled but do not imply a broker order:

- `WATCHLIST`
- `DELAYED_EP_WATCH`
- `PEAD_HANDOFF`
- `IGNORE`
- `REJECTED`

If all candidates are non-actionable, the output is `NO_ACTIONABLE_ORDERS`.

## Blocking Rules

An actionable candidate is `NO_GO` when:

- `entry_in_written_plan` is not true
- `stop_predefined` is not true
- `size_within_plan` is not true
- `actual_risk_dollars` is greater than `planned_risk_dollars`
- A losing exit or partial trim exists inside the revenge window
- Market-regime recommendation is `REDUCE_ONLY` or `CASH_PRIORITY`
- Circuit-breaker recommendation is `COOLDOWN`, `HALTED`, or `TRADING_HALTED`

Market-regime recommendation `NEW_ENTRY_ALLOWED` and circuit-breaker recommendation `TRADING_ALLOWED` are the only explicit pass values. Unknown or missing upstream artifacts produce `REVIEW_REQUIRED` for actionable orders.

## Trader Memory Integration

Revenge-risk detection reads trader-memory-core thesis YAML files:

- `status_history[].realized_pnl < 0` counts partial trims and terminal ledger events.
- Terminal theses with no ledger `realized_pnl` fall back to `outcome.pnl_dollars < 0` when a terminal date can be inferred.
- Date-only producer timestamps expanded to `YYYY-MM-DDT00:00:00+00:00` are counted on the named ET date, matching the drawdown-circuit-breaker behavior.
- Events after `--as-of` are ignored.

When `thesis_id` and `--state-dir` are provided, the skill links the generated JSON report with trader-memory-core `link_report`. It never uses `mark_reviewed`, because pre-trade checklist logging must not advance monitoring review dates.

The JSON report and JSONL journal retain candidate-level `checklist_answers` for `entry_in_written_plan`, `stop_predefined`, `size_within_plan`, `planned_risk_dollars`, `actual_risk_dollars`, and `notes`. This keeps GO decisions reviewable later instead of recording only failures.

## Workflow Integration

In `swing-opportunity-daily`, the gate runs after thesis registration and consumes same-workflow artifacts such as `candidate_journal_entry`, `position_sizing`, `trade_plans`, and `circuit_breaker_decision`.

In `stockbee-ep-daily`, the workflow first runs `drawdown-circuit-breaker` to produce `circuit_breaker_decision`, then runs this gate only for ACTIONABLE_DAY1 / ENTRY_READY manual-order candidates. Delayed EP, PEAD handoff, and ignored candidates are recorded as no-action orders.

`exposure_decision` remains a prerequisite workflow artifact. It should be supplied to the CLI by path; it is not listed under workflow `consumes` because strict workflow validation only permits artifacts produced earlier in the same workflow.
