# P6 date frame in `think`: held-out verdict

The custodian (P0) ran the preregistered sealed cell once on the frozen build
(candidate `2815a8368cb38d2bbc8bf23bf2c3d2ca34aa6756`, baseline
`67c4ff27bd0a5a8a02ccb66cd663d3aa1daf9969`), harness gbrain-evals
`p0-heldout-harness@cf270c2` (`memory-qa` think lane, `balanced`, reranker off,
autocut off, top 10, official judge prompts; `referenceDate` = question date,
or the conversation's latest session date for LoCoMo). Spec:
[`decision.json`](decision.json); preregistration:
[`TIME_AWARE_RETRIEVAL_PREREG.md`](../../TIME_AWARE_RETRIEVAL_PREREG.md),
amendment 3. The sealed receipts stay with the custodian. Verdict: **pass**.

## LoCoMo sealed (7 conversations, 1,399 paired questions)

| Gate | Result |
|---|---|
| Judged accuracy, paired, clustered by conversation | 74.2% → 88.2%, **+14.0 pts, 95% CI [+11.8, +16.2]**; 229 wins / 33 losses, sign test p = 3 × 10⁻³⁷ |
| Every conversation | improves, +8.7 to +21.0 pts |
| No question category down by more than one question | holds; temporal 27 → 199 of 221 |
| Retrieval | identical in both arms |
| Errors | 0 |

**Disclosure.** The first run hit its $80 ledger cap; the 142 rows the cap
refused were answered in a second run with the same build, harness and
settings. Total spend about $162.

## Latency bar

`think` p95 latency within +20% was preregistered; the sealed lane records
retrieval latency only, so think latency was measured on development data
(latency is not held-out-sensitive): the LongMemEval-S 150-question dev
sample, both frozen builds in parallel processes on one machine, the same
think model (`anthropic:claude-sonnet-5-5`) and questions, wall time around
each `runThink` call (a local timing line on harness `cf270c2`).

| | Baseline | Date frame |
|---|---:|---:|
| p50 | 6.28 s | 6.05 s |
| p95 | 13.67 s | 12.66 s |

p95 ratio 0.93 (bootstrap 95% CI [0.88, 1.03]): **within the bar**; the date
frame adds two short lines to the prompt and no model call. The same run
reproduced the accuracy gain (80.0% → 89.3%). Spend about $26.

## Default

The date frame has no setting: `think` always carries the current-date line
and page content dates, and `reference_date` / `--reference-date` pins
"today". It ships on.

## Pending

LongMemEval-M sealed think runs next as disclosed confirmation; it is
recorded here when it lands.
