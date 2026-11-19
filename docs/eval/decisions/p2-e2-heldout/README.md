# Date-grounded extraction: held-out verdict (PASS)

Decision `p2-e2-heldout-2026-10-04` ran on the 7 sealed LoCoMo conversations (1,076 questions). The evaluation
custodian ran it under preregistration amendment 1 (gbrain-evals `docs/benchmarks/2026-10-04-p2-ranking-extraction-preregistration.md`).

The candidate was `extraction.date_grounding=true` on the frozen build. The baseline was the same build with the
setting absent. Both arms ran the decision kit's facts lane: foresights's conversation-facts extractor on dated
conversation pages, two extractions per arm, and a fixed reader that answers from the saved facts with 10
replicates. The gate is correctness first. It decides on the share of saved facts that still hold a relative date
("yesterday", "3 days ago") with no absolute date. QA has to stay non-inferior.

| Gate | Baseline → candidate | 95% CI | Result |
|---|---|---|---|
| Primary: unresolved relative-date share in saved facts | 8.95% → 2.05% (−77% relative; bar ≥ 50%) | [−8.3, −5.5] pts | pass |
| Temporal QA from saved facts (lower bound ≥ −3 pts) | 67.5 → 68.3 | [−1.2, +2.7] | pass |
| Overall QA from saved facts (lower bound ≥ −3 pts) | 53.6 → 54.7 | [+0.6, +1.7] | pass |
| Page recall@5 (lower bound ≥ −1 pt) | unchanged | — | pass |
| Facts per conversation (within ±5%) | −0.3% | — | pass |

All 7 conversations improved individually on the primary metric.

## Default

`extraction.date_grounding` defaults on for fact extraction and for the three other prompts that passed their per-consumer
check. `false`, `off` or `0` turns all of them off. `true` also turns on life chronicle events, the one prompt that did not
pass. `foresights doctor` (`extraction_date_grounding`) reports which prompts are grounded on a brain.

Facts extracted before the default changed keep their original wording. Re-extracting a source is an explicit,
previewed action that needs the user's consent: `foresights extract-conversation-facts --source-id <id> --dry-run`.

## Per-consumer checks (preregistration amendment 3)

The held-out verdict measured fact extraction. The four other prompts that know the rule were each checked on 30 invented
dated fixture pages. Each fixture has 3–6 relative time references, a decision, a plan and a prediction, and fixtures were
written by `google:gemini-3.8-flash` before any prompt ran. Each prompt ran twice per fixture through its own product
prompt builder (`anthropic:claude-sonnet-5-5`): as today, and grounded. Two measures:
- unresolved relative phrases in the stored items (the facts lane's check);
- a blind pairwise judge (`openai:gpt-6-sol`, 10 replicates per fixture, A/B order randomized per replicate).

Pass needs (a) fewer unresolved phrases when grounded, and (b) a judge score (grounded win 1, tie 0.5, loss 0) with a 95%
bootstrap lower bound of at least 0.45.

| Prompt | Unresolved phrases, current → grounded | Judge score (95% CI) | Verdicts (grounded / tie / current) | Result | Default |
|---|---|---|---|---|---|
| dream synthesis | 49 → 1 (475 → 615 items) | 0.813 (0.71, 0.92) | 224 / 40 / 36 | pass | on |
| extract_atoms | 5 → 0 (66 → 69 items) | 0.973 (0.94, 0.99) | 292 / 0 / 8 | pass | on |
| propose_takes | 10 → 0 (96 → 99 items) | 0.933 (0.87, 0.99) | 275 / 10 / 15 | pass | on |
| life chronicle events | 0 → 0 (149 → 155 items) | 0.937 (0.86, 0.99) | 281 / 0 / 19 | fail (a) | opt-in (`true`) |

Life chronicle events fails criterion (a) on a floor: its events already carry an absolute `when` field, so neither arm
stored an unresolved phrase (0 → 0). The judge preferred the grounded events in 281 of 300 comparisons. The preregistered
bar is applied as written, so chronicle stays on its current prompt unless the setting is `true`. Changing that would
need a new preregistered check.

The fixtures, outputs, judgments and the script that produced them are in gbrain-evals at
`docs/benchmarks/p2-e2-consumers/` (branch `capy/p2-preregistration`). `per-consumer-report.json` here is the summary.
The budget ledger did not meter this spend, because the calls went to providers directly; the preregistered estimate was $12.

## External development check (report-only)

This check does not change the default. The default follows the preregistered sealed verdict above: correctness was the
primary gate and passed, and QA non-inferiority held on sealed LoCoMo.

GBRA-52 ran date grounding on and off in its BEAM development lane (100k, 500k and 1M; 158 sessions, all dated). The lane
combines retrieval with a 600-token facts block inside 8k tokens of delivered context, with a gemini reader and judge.

| Measure | Grounding on | Grounding off | Paired (W / L / T) |
|---|---|---|---|
| Pooled rubric | 0.653 | 0.663 | 35 / 51 / 274, mean −0.010; losses concentrated at 1M |
| Temporal | 0.438 | 0.493 | 0 / 3 / 33 |
| Event ordering | — | — | 6 / 10 |

With grounding on, 4.9–8.4% of facts carry a `valid_from` that differs from the session date, a median of 3–4 days earlier.

GBRA-52's reading: in this lane the dates rarely reach the reader. Recall returns the newest 100 facts, of which only 3–6%
are dated, and the block holds 600 tokens. So the result says little about correctness, and it shows no QA gain at that
budget. Receipts: gbrain-evals branch `capy/mpw-harness` at 8ec0330,
`docs/benchmarks/2026-10-05-memory-proof-wave-dev/facts-lanes-fix2-date-grounding.md`.

Follow-up: measure date-grounding QA on fixed BEAM with a facts budget large enough for the dates to reach the reader.

Development record: `../p2-date-grounding-dev/`.
