# SkillOpt judge LLM accuracy eval (F9)

Hand-labeled (trajectory, expected_score) pairs. Measures whether the judge
model's scores agree with human judgment within reasonable bounds.

## Fixtures

`fixtures.jsonl` — one row per (judge_kind, rubric, trajectory, gold_score)
quadruple. Gold scores are integer 1-5 (per common Likert practice);
normalized to 0..1 inside the runner.

## Runner

`runner.mjs` reads fixtures, calls `scoreTrajectory`, computes per-fixture
absolute error vs gold, aggregates to mean absolute error (MAE).

Pass criterion: MAE <= 0.15 on the 0..1 scale (judge agrees with gold
within ~one-eighth of the full range).

## Cost

~10 fixtures × ~$0.005 each = $0.05 per run. Refresh when the judge prompt
changes or when switching judge models.

## Reproduce

```bash
node evals/skillopt-judge/runner.mjs \
  --judge-model anthropic:claude-sonnet-4-6 \
  --output evals/skillopt-judge/receipts/$(date +%Y%m%d).json
```
