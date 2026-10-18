# Take-grading eval (W6, wave 4b)

Measures which chat models may grade a forecasting take: when the `grade_takes` cycle phase's auto-resolve rule would apply a verdict (not `unresolvable`, confidence at or above `GRADE_TAKES_AUTO_RESOLVE_THRESHOLD`, 0.95), how often is it wrong? The result decides `GRADE_TAKES_MEASURED_MODELS` (`src/core/cycle/grade-takes-measured.ts`), which `gbrain takes grades` uses to mark verdicts no measurement backs. Auto-resolve stays off. The preregistration is [`PREREGISTRATION.md`](PREREGISTRATION.md); raw results and the verdict are mirrored into gbrain-evals (`docs/benchmarks/2026-10-16-take-grading*`).

## Current result

Measured 2026-10-16 at gbrain `d99b84694` (branch `capy/w6-take-grading`, prompt `hybrid-evidence-v2`, threshold 0.95), the commit that froze the preregistration; one run per model over the 790 counted takes, $9.25 in all. Only gpt-6.1-sol qualifies.

| Model | Applied | Wrong applied | Upper 95% | Coverage | Abstention | No answer | USD per verdict | Latency p50 / p95 | Qualifies |
|---|---|---|---|---|---|---|---|---|---|
| `openai:gpt-6.1-sol` | 496 | 0 | 0.6% | 99.2% | 100% | 1 | $0.0016 | 2.4 s / 3.2 s | yes |
| `anthropic:claude-sonnet-5-5` | 121 | 1 | 3.9% | 24.0% | 99.6% | 14 | $0.0032 | 1.7 s / 4.5 s | no |
| `anthropic:claude-opus-5-5` | 2 | 0 | 77.6% | 0.4% | 100% | 3 | $0.0069 | 2.7 s / 4.9 s | no |

So `GRADE_TAKES_MEASURED_MODELS` is `openai:gpt-6.1-sol`, for verdicts asked with prompt `hybrid-evidence-v2` (`GRADE_TAKES_MEASURED_PROMPT_VERSION`). gpt-6.1-sol gave the gold verdict on every one of the 750 takes in the rule and held back on every unresolvable one; it sits near the ceiling of these synthetic fixtures, so the result says the judge reads clean evidence correctly, not how it does on a real brain's messier evidence. Opus 5.5 gave the gold verdict on all 500 resolvable takes but at confidence below 0.95 on all but two, so the rule applies almost none of its verdicts; it called 5 pre-horizon takes `incorrect` below the threshold. Sonnet 5.5's one wrong applied verdict (`counted-world_no_evidence-013`) graded a real-world proposition with no evidence from its own knowledge; it also called 13 pre-horizon takes `incorrect` below the threshold.

Exploratory sets, outside the rule: on `partial` (a stated target missed by a margin), all three models answer `incorrect` (gpt-6.1-sol 18 of 20, applied at 0.96 or more), so whether a shortfall is `partial` or `incorrect` is a grading policy to settle before auto-resolve. On `world_counterfactual`, gpt-6.1-sol applied all 20 verdicts on the brain's evidence over the real outcome; Sonnet 5.5 and Opus 5.5 applied none.

Of the 18 answers with no verdict, 12 (Sonnet 5.5 9, Opus 5.5 3) used the judge's whole 600-token output ceiling and left a short or empty visible answer, so the Anthropic models spend the ceiling on thinking; the judge call passes no thinking setting. Four were Sonnet 5.5 JSON with a stray trailing `,"}`, one was gpt-6.1-sol JSON missing its closing brace, and one was a Sonnet 5.5 answer that corrected itself from `incorrect` to `correct`, which the parser rejects by design. A thinking setting or a larger ceiling for the judge, and a tolerant parse of the trailing comma, are proposed for a later dated preregistration and not changed here; each costs coverage, never correctness. Raw rows, `summary.json`, `summary.md` and `verdict.json` live in gbrain-evals (`docs/benchmarks/2026-10-16-take-grading/`); nothing is committed under `results/` here.

## What's here

| File | Role |
|---|---|
| `cases.ts` | Seeded builder of 908 synthetic takes with dated evidence: dev 118, counted 790, across eight sets in the rule (resolved correct and incorrect, pre-horizon, pre-claim, no evidence, restatement, near-name distractor, real-world proposition without evidence) and two exploratory sets (partial, world counterfactual). Placeholder names only. |
| `generate-fixtures.ts` | `cases.ts` → `fixtures.jsonl` (committed). Counted is built first and dev avoids its claims. Regenerate after editing a case; the keyless test fails on drift. |
| `check.ts` | The $0 instrument checks (counts, placeholders, the dates each set promises) and the production take row and evidence block each fixture becomes. |
| `score.ts` | Pure grading and summaries: applied and wrong per verdict, coverage, abstention, the Clopper-Pearson bound, the decision rule and the ranking. |
| `report.ts` | The JSON report and the Markdown tables, including the proposed `GRADE_TAKES_MEASURED_MODELS`. |
| `harness.ts` | Runner: `--check` ($0), live (`--model`, `--split`, `--out`, `--max-usd`: the production `defaultJudge` call per fixture; the counted split needs `--preregistration <commit>`) and `--score`. |

The keyless test is `test/eval-take-grading.test.ts`. It guards the instrument, not the score.

## Running

```bash
# Prove the instrument ($0, no key):
bun evals/take-grading/harness.ts --check

# One live dev run (needs the provider key; stops at the cap):
bun evals/take-grading/harness.ts --model openai:gpt-6.1-sol --split dev --out results/gpt-dev.jsonl --max-usd 1

# A counted run, only after PREREGISTRATION.md is frozen:
bun evals/take-grading/harness.ts --model openai:gpt-6.1-sol --split counted --out results/gpt.jsonl --max-usd 3 --preregistration <commit>

# Score saved runs ($0):
bun evals/take-grading/harness.ts --score results/*.jsonl --json summary.json --md summary.md
```

## Metrics

- **Wrong share of applied verdicts** (preregistered): one-sided 95% Clopper-Pearson upper bound at most 1%, so at least 299 clean applied verdicts.
- **Coverage**: resolvable takes applied and right, over resolvable takes in the rule.
- **Abstention**: unresolvable takes not applied, over unresolvable takes in the rule.
- **No answer**: no usable verdict (parse failure, provider unavailable); safe, reported apart.
- **Cost and latency**: USD per verdict from gbrain's price table; wall time p50 and p95.

Ranking: qualifying models first, by coverage, ties to the cheaper model.
