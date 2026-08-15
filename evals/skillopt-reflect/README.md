# SkillOpt reflect-prompt quality eval (F8)

Gold-labeled trajectories paired with expected-edit shapes. Measures whether
the optimizer model's reflect prompt proposes the kind of edit a human would
write given the same trajectory.

## Fixtures

`fixtures.jsonl` — one row per (skill_body, scored_rollouts, expected_edits)
triple. The `expected_edits` are loose shape constraints (the op kind + a
substring of the target/anchor), not exact-text equality, because LLMs
won't propose byte-identical text.

## Runner

`runner.mjs` reads `fixtures.jsonl`, calls `runReflect` for each fixture,
checks every proposed edit against the expected_edits set, and writes a
JSON receipt with per-fixture pass/fail + aggregate hit rate.

Pass criterion: aggregate hit rate >= 0.7 (each fixture has 1-3 expected
edits; the optimizer "wins" the fixture if at least one of its proposals
matches an expected shape).

## Cost

~5 fixtures × ~$0.10 each (Opus reflect call) = ~$0.50 per run. Refresh
the suite when the reflect prompt changes; otherwise weekly is enough.

## Reproduce

```bash
node evals/skillopt-reflect/runner.mjs \
  --optimizer-model anthropic:claude-opus-4-7 \
  --output evals/skillopt-reflect/receipts/$(date +%Y%m%d).json
```
