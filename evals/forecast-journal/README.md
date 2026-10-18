# Forecast-journal gate (W7)

The $0 synthetic gate for the private forecast journal (`src/core/forecast-journal.ts`, `gbrain takes journal`, `gbrain takes scorecard --group-by`). It checks three things on placeholder holders of known skill and placeholder topic pages:

- whether the per-holder statistics rank holders in their true order;
- whether the journal answers "who was right about T" and keeps the unresolved denominator;
- whether remote callers see none of it while their existing output stays the same.

The preregistration is [`PREREGISTRATION.md`](PREREGISTRATION.md).

## Current result

**PASS.** Measured on 2026-10-17 at gbrain `65ed40ec6` (branch `capy/w7-forecast-journal`), using the instrument and preregistration frozen in that commit. It was one run of all 20 cohorts and 5,622 predictions. It cost $0 and took 7.4 s on in-memory PGLite.

| Criterion | Threshold | Result |
|---|---|---|
| Median Spearman ρ, shrunk accuracy vs true skill (12 holders, n ≥ 10) | ≥ 0.80 | **0.905** (18 of 20 cohorts ≥ 0.80; lowest 0.741 and 0.748) |
| Who-was-right set-F1, macro over 800 topic-cohorts | ≥ 0.95 | **1.000** |
| Denominator (journal totals; each holder's n, unresolved, overdue, open) | exact | 0 mismatches |
| `low_n` flags | exact | 0 mismatches |
| Prediction times labelled `since_date`, uncertified | exact | 0 mismatches |
| Remote probes | all pass | **8/8** |

The median ρ for raw accuracy is also 0.905, so on these cohorts shrinkage neither helps nor hurts the median rank order. It changes ρ in 13 of 20 cohorts by −0.084 to +0.035. The cohorts with n from 10 to 30 differ less in sample size than a real brain would. Shrinkage matters most for a holder with few resolved predictions, and those holders are flagged `low_n` and kept out of ρ.

The set-F1 of 1.000 and the exact counts are a ceiling. The journal reads the resolutions it was given, so these criteria guard against regressions rather than measure something hard. The ranking criterion is the only one with sampling noise.

The run's `summary.json` and `summary.md` are not committed here. They are mirrored into gbrain-evals when W7 ships.

## What's here

| File | Role |
|---|---|
| `fixtures.ts` | Deterministic generator: 20 cohorts. Each has 12 holders of skill 0.30 to 0.90 (10 to 30 resolved predictions each), 2 low-n holders, one overdue and one open prediction per holder, and one undated take, over 40 topic pages. Placeholder names only. The output hash is frozen in the preregistration. |
| `score.ts` | Pure statistics: Spearman ρ (average ranks for ties), set F1, the median, and the preregistered decision rule. |
| `harness.ts` | `--check` ($0 instrument check) and `--run` ($0, in-memory PGLite: loads the cohorts, applies the horizon scan, measures through the production readers and op handlers, and applies the rule). |

The keyless test is `test/eval-forecast-journal.test.ts`. It guards the instrument, not the score.

## Running

```bash
bun evals/forecast-journal/harness.ts --check
bun evals/forecast-journal/harness.ts --run --json summary.json --md summary.md
```

Both cost $0 and need no key. `--run` exits 0 when the gate passes and 1 when it fails.
