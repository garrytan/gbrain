# Preregistration: which model may grade a take? (2026-10-16)

Frozen on October 16, 2026, before any counted run, with the fixtures in the same change (`fixtures.jsonl`, generated from `cases.ts`). Nothing here changes after a counted run; a later change gets a new dated file. The gbrain-evals mirror carries a copy with the results.

## The question

The dream cycle's `grade_takes` phase (`src/core/cycle/grade-takes.ts`) walks unresolved forecasting takes whose claim is old enough to have played out, retrieves dated evidence from the brain, and asks a chat model for one verdict: `correct`, `incorrect`, `partial` or `unresolvable`, with a confidence. It caches the verdict in `take_grade_cache`. Auto-resolve, which would write the verdict onto the take, exists in the code and is off; the cycle never turns it on. Before anyone turns it on, the plan (wave 4b, W6) asks for a measurement: when the production rule would apply a verdict (not `unresolvable`, confidence at or above `GRADE_TAKES_AUTO_RESOLVE_THRESHOLD`, 0.95), how often is it wrong?

The damage is asymmetric. A wrong applied verdict silently rewrites a person's track record and feeds the calibration profile. An `unresolvable` or a low-confidence verdict costs a review, never correctness. So this experiment asks:

1. Among the verdicts the rule would apply, what share is wrong, and how tight is the bound (**wrong share of applied verdicts**)?
2. How many resolvable takes does a model grade correctly and confidently enough to apply (**coverage**)?
3. How often does it hold back on a take the evidence cannot settle (**abstention**), and what does each verdict cost?

## The fixtures

`evals/take-grading/fixtures.jsonl` in gbrain: 908 synthetic takes with known outcomes, each with the dated evidence hits the judge sees, shaped like the production retriever's (`slug`, `title`, `chunk_text`, `effective_date`). Companies and people are placeholders (`*-example`); the only real-world subjects are the public propositions of the `world_*` sets (prices, rates, events), which name no person or company. Built deterministically from fixed seeds by the agent running the experiment; no person reviewed them.

Two splits. **dev** (118 fixtures) tuned the prompt and parser and is never counted. **counted** (790 fixtures) decides; it is built first and dev avoids its claims. Every company take states a horizon (`by the end of 2023`, `by Q3 2024`, `within 18 months`, `before 2025`), and every hit is dated relative to the take's `since_date` and that horizon. Every company fixture except `no_evidence` also carries zero to two noise hits about other companies (a meeting moved, a lease renewed).

| Set | Counted | Shape | Gold | In the rule |
|---|---|---|---|---|
| `resolved_correct` | 250 | A dated hit after the horizon reporting the outcome (60%), or an early achievement before it (40%); some carry an earlier progress hit, always before the achievement. | `correct` | yes |
| `resolved_incorrect` | 250 | A dated hit after the horizon reporting the miss; some carry earlier progress. | `incorrect` | yes |
| `pre_horizon` | 60 | Only progress hits dated before the horizon. | `unresolvable` | yes |
| `pre_claim` | 40 | Only background hits dated before the take was made. | `unresolvable` | yes |
| `no_evidence` | 40 | No hits at all. | `unresolvable` | yes |
| `restatement` | 40 | A hit after the horizon in which the holder restates the claim; no outcome. | `unresolvable` | yes |
| `distractor` | 40 | The decisive-looking hit is about a similarly named different company (`<word>-<suffix>-example`). | `unresolvable` | yes |
| `world_no_evidence` | 30 | A public real-world proposition with no evidence in the brain. | `unresolvable` | yes |
| `partial` | 20 | A hit reporting a shortfall (part of the target met). | `partial` | no, exploratory |
| `world_counterfactual` | 20 | A public proposition with a known real outcome; the brain's dated note says the opposite. | the brain's side | no, exploratory |

So the rule sees 750 counted fixtures, 500 of them resolvable. The two exploratory sets are reported and never decide: `partial` has no agreed grading, and `world_counterfactual` measures whether a model follows the brain or its own world knowledge, which is a policy question this experiment does not settle.

The $0 check (`bun evals/take-grading/harness.ts --check`, also the keyless test `test/eval-take-grading.test.ts`) proves the instrument: `fixtures.jsonl` matches `cases.ts`, the counts above, placeholder names only, the dates each set promises (an outcome hit after the horizon, or an early achievement after the claim with any progress before it; pre-horizon hits between the claim and the horizon; background before `since_date`; a distractor's decisive hit about a near-name company and none about the subject; no hits in the no-evidence sets), and that every fixture renders through the production evidence block.

## The arms

Per the gbrain project rule on eval models (2026-10-07): the newest frontier model of each family, no Fable in counted runs, no gpt-5.4-mini, no older generation. No earlier take-grading result exists, so no link model is needed.

| Model | Why it runs |
|---|---|
| `openai:gpt-6.1-sol` | Newest GPT. |
| `anthropic:claude-opus-5-5` | Newest Opus; the top Anthropic model in counted runs. |
| `anthropic:claude-sonnet-5-5` | Newest Sonnet; the cheaper Anthropic candidate. |

One run per model over the 790 counted fixtures: 2,370 verdicts. Per-model caps (`--max-usd`) are $3 for gpt-6.1-sol, $5 for Sonnet 5.5 and $10 for Opus 5.5, $18 in all, under the $25 counted ledger; the dev round predicts about $1.20, $2.60 and $5.80.

## The procedure

`bun evals/take-grading/harness.ts --model <id> --split counted --out <file> --max-usd <cap> --concurrency 4 --preregistration <commit>`, Bun 1.4.x, per model, where `<commit>` is the gbrain commit that froze this file:

1. Each fixture becomes the production take row and the production evidence block (`formatEvidenceBlock`); the fields the judge must not see (`decisive`, `about`) are stripped first.
2. The verdict comes from `defaultJudge` in `grade-takes.ts`: the production prompt (`GRADE_TAKES_PROMPT_VERSION` `hybrid-evidence-v2`), one gateway `chat` call with the production options, and the production parser (`parseJudgeOutput`). The harness wraps the chat call only to read token usage. A parse failure stands as no answer (production retries it on the next cycle); a provider error is retried up to twice after a pause.
3. Each row records the verdict, confidence, whether the rule applies it and whether it is wrong, tokens, USD from gbrain's own price table, wall time, the judge's reasoning, and the raw answer on a parse failure. The run's `.meta.json` records the gbrain commit, this preregistration commit, the prompt version and hash, the threshold, and the fixture and harness hashes.
4. A run that hits its cap stops, is reported as incomplete, and its model does not qualify. No counted run is repeated or extended.

Evidence retrieval is not measured: the hits are given, so this measures the judge on the evidence it would see, not whether the retriever finds it.

## Measurements

- **Wrong share of applied verdicts**: wrong / applied over the rule's 750 fixtures, with the one-sided 95% Clopper-Pearson upper bound. On a gold-`unresolvable` fixture every applied verdict is wrong.
- **Coverage**: resolvable fixtures applied and right, over the 500 resolvable fixtures.
- **Abstention**: unresolvable fixtures not applied, over the 250 unresolvable fixtures.
- **No answer**: fixtures with no verdict, by failure (`parse`, `unavailable`); safe, the take stays ungraded.
- **Cost**: USD per verdict; **latency** p50 and p95.
- Exploratory, never decisive: outcomes per set and class, the verdicts on `partial`, and on `world_counterfactual` whether the verdict follows the brain or the real outcome.

## Decision rule

A model **qualifies** when it applied at least one verdict and the one-sided 95% Clopper-Pearson upper bound on wrong / applied is **at most 1%** (`MAX_WRONG_UPPER` in `score.ts`). That needs at least 299 applied verdicts with none wrong, or 473 with one wrong. Abstention and coverage do not enter the rule except through the applied count.

`GRADE_TAKES_MEASURED_MODELS` (`src/core/cycle/grade-takes-measured.ts`) lists the qualifying models, **best first by coverage, ties to the cheaper model** (lower USD per verdict). If no model qualifies, the constant stays empty and the report says so. Qualifying does not turn auto-resolve on: in this release the list only marks, in `gbrain takes grades`, which cached verdicts a measured judge gave. Whether auto-resolve is ever wired, and on what real-sample check, is a separate decision.

A model at 100% coverage and abstention is reported as a ceiling. Models are reported in rank order.

## Dev results (context, not counted)

Two dev rounds ran before this freeze, $2.87 of the $4 dev cap. Round one used prompt version 1; gpt-6.1-sol applied 63 verdicts with 4 wrong, all four on `distractor` fixtures, where it graded the similarly named company's outcome. The prompt gained one paragraph (evidence about a different entity whose name only resembles the claim's does not count) and became `hybrid-evidence-v2`; the parser learned to read an answer with prose around the JSON, or a repeated answer that agrees, after Sonnet 5.5 gave no parseable answer on 9 fixtures, most of them a first JSON answer followed by a corrected one. Round two, prompt v2:

| Model | Applied | Wrong | Upper bound | Coverage | Abstention | No answer | USD per verdict |
|---|---|---|---|---|---|---|---|
| `openai:gpt-6.1-sol` | 60 | 0 | 4.9% | 100% | 100% | 0 | $0.0015 |
| `anthropic:claude-sonnet-5-5` | 12 | 0 | 22.1% | 20% | 100% | 1 | $0.0033 |
| `anthropic:claude-opus-5-5` | 0 | 0 | — | 0% | 100% | 1 | $0.0073 |

Opus 5.5 gave the gold verdict on most resolvable dev fixtures but never at confidence 0.95 or above, so the rule applied none. Sonnet 5.5 reached 0.95 on a fifth of them. Under this rule those two are unlikely to qualify on the counted split; they run anyway, because the project rule asks for the newest model of each family and their counted result is what a later threshold or prompt decision would start from. After round two the fixtures were regenerated once, to place progress hits before an early achievement (a dev `resolved_correct` fixture had progress after the achievement it led to); the check now enforces it.

## What this does not change

The prompt, parser, threshold and fixtures are not edited during the counted runs; weaknesses found are proposed with evidence for a later dated preregistration. Auto-resolve stays off.
