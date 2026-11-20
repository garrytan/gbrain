**`gbrain eval trajectory` and `gbrain founder scorecard` no longer call falling churn, burn or cost a regression; they flag the rise instead.**

### Fixed
- For lower-is-better metrics (the exact names `burn_rate`, `churn_rate`, `cac`, `burn`, `churn`, and any metric with the whole word cost, expense, loss, latency, payback or debt, plus costs, expenses, losses, debts), a rise of 10% or more is the regression ("burn rose 33.3%") and a drop is not. Every other metric keeps "a 10% drop is a regression". `lossless`, `costco` and `debtor` do not match. The whole list is one constant, `LOWER_IS_BETTER` in src/core/trajectory.ts, so a later change is one edit.
- Each `regressions[]` entry in `find_trajectory` and `eval trajectory --json` gains an optional `direction` (`down` or `up`); `schema_version` stays 1. The text marker reads `[REGRESSION ↑N%]` for a rise.
- The scorecard's `growth_trajectory` delta now divides by the absolute prior value, so a loss shrinking from -100000 to -50000 reads `up`, +50%, like the regression math.

<!-- behavior-change: trajectory_lower_is_better_memory01 -->
