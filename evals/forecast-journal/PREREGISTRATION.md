# Preregistration: does the forecast journal rank and count predictions correctly? (2026-10-17)

Frozen on October 17, 2026, before any scored run, together with the instrument in the same change: `fixtures.ts` (the generator), `score.ts` (the statistics and the decision rule) and `harness.ts` (the runner). Nothing here changes after a run; a later change gets a new dated file. Before freezing, the only thing run was a plumbing smoke of the op handlers on a one-take brain that is not part of the fixtures. It checked that a remote context with a holder allowlist returns rows. Nothing was scored.

fixtures sha256: `ad271efc7fb94cc53170984619bb9a9346c9ca98fdec826e6d8e66046a9fd44a`

## The question

W7 (wave 4b) gives the brain's owner a private forecast journal: every prediction with its prediction time, horizon, state and resolution, and `takes_scorecard {group_by}` with per-holder statistics. The plan's gate for W7 is $0 and synthetic (gbrain-evals `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`, wave 4, row W7). This run asks four questions:

1. When holders differ in skill, does the per-holder Beta-shrunk accuracy rank them in their true order (**Spearman ρ**)?
2. Does the journal answer "who was right about T" with the right set of holders (**set-F1**)?
3. Does it keep the unresolved denominator (every overdue, open and undated prediction counted), flag `low_n` holders, and label every prediction time it cannot certify?
4. Is none of this visible to a remote caller, and is what remote callers already get unchanged (**N6-style probes**)?

It does not measure anything about real people. Every holder and every page is a placeholder (`holder-NN-example`, `companies/topic-NNN-example`).

## The fixtures

`fixtures.ts`, seed 20261017, gives 20 cohorts. Each cohort runs on its own source:

- **12 skilled holders** with a known skill of 0.30 to 0.90, evenly spaced. Skill is the probability that a resolved prediction comes out correct. Each holder has 10 to 30 resolved predictions (uniform).
- **2 low-n holders** (skill 0.6), with 4 resolved predictions each.
- **One overdue and one open prediction per holder.** The overdue one states "by the end of 2025", so its horizon is before the as-of date, 2026-10-16. The open one states "by the end of 2030".
- **One undated take per cohort**, with no deadline.
- **Every prediction is a bet** about one of 40 topic pages, chosen uniformly. It states "by the end of YYYY" (2021 to 2024 for resolved ones), with a stated weight of 0.55 to 0.95, a since_date in the year before, and resolution 0 to 6 months after the horizon. 80% of resolutions cite a source.

That makes 5,622 predictions in all. Takes are written through the engine, not the page write path, so no belief ledger records them: every prediction time is the since_date, uncertified.

The $0 check (`bun evals/forecast-journal/harness.ts --check`, also in the keyless test `test/eval-forecast-journal.test.ts`) proves the instrument:

- The generator's output hash equals the one above.
- There are 20 cohorts with 14 holders each.
- The declared resolved counts match the predictions.
- Every holder and topic is a placeholder.

## The procedure

`bun evals/forecast-journal/harness.ts --run --json summary.json --md summary.md`, Bun 1.4.3, in-memory PGLite, no key and no network:

1. Load every cohort: one `sources` row, 40 topic pages through `putPage`, the takes through `addTakesBatch`, and the resolutions in one update.
2. Capture four outputs on cohort 1. Three come from a remote context with a holder allowlist covering every cohort-1 holder (an N6-style grant that can read them): `takes_list {}`, `takes_search {query: "milestone"}` and `takes_scorecard {}`. The fourth is local `takes_scorecard {}`.
3. Apply the stated-horizon scan (`scanStatedHorizons {apply: true}`), as `gbrain takes horizon scan --apply` does. Capture the same outputs again.
4. For each cohort, read `scorecardGroups {groupBy: holder, minN: 10}` and `readForecastJournal`. For each topic, read `readForecastJournal {about: topic, state: resolved}`, all as of 2026-10-16.

## Measurements and decision rule

The gate **passes** only when every criterion holds:

| Criterion | Measure | Threshold |
|---|---|---|
| Ranking | Per cohort, Spearman ρ between true skill and `accuracy_shrunk` over the 12 holders with n ≥ 10 (average ranks for ties); the median over the 20 cohorts | ≥ 0.80 |
| Who was right about T | Per topic and cohort, F1 between the holders with a correct resolved prediction on the topic (gold) and the holders of the journal's resolved entries graded `correct` for `about: topic`; two empty sets score 1; the macro average over 800 topic-cohorts | ≥ 0.95 |
| Denominator | Journal totals (predictions, resolved, unresolved, open, overdue, undated, certified times = 0) and each holder's `n`, `unresolved`, `overdue`, `open` equal the gold counts | exact |
| `low_n` | `low_n` is true exactly for holders with fewer than 10 resolved predictions | exact |
| Labelling | Every prediction's time is `{at: since_date, basis: since_date, certified: false}` | exact |
| Remote probes | Remote `takes_list` and `takes_search` are non-empty, unchanged by the horizon scan, and carry no horizon, prediction or journal field. Remote `takes_scorecard {}` counts the bets, is unchanged, and has no `groups` or `journal`. Local `takes_scorecard {}` is unchanged. Remote `{group_by: holder}`, `{group_by: source}` and `{min_n: 5}` are refused with `scorecard_group_by_local_only`. No MCP op name contains `journal` or `horizon`. | all pass |

Reported but not decisive: per-cohort ρ, the share of cohorts at ρ ≥ 0.80, and ρ for raw accuracy beside shrunk accuracy. The plan calls the ρ criterion a diagnostic: it tests whether the shrinkage keeps the true order through sampling noise, not whether any real holder is ranked well. A ranking of real people stays deferred behind an independently adjudicated gate (plan, challenge 6).

## What this does not change

The fixtures, the readers and the statistics are not edited after a run. If the gate fails, the failure is reported with its cause. A fix then goes in a new change, with a new dated preregistration before any rerun.
