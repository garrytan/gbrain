# P8 dev results

These are development-split results for each switchable P8 part. They guided the work and fixed the
[preregistration](PREREGISTRATION.md); none of them turns a default on. Receipts live in gbrain-evals under
`docs/benchmarks/2026-10-04-p8-dev/` (branch `p8-dev-evals`), and the P0 decision kit's spec and verdict are in
[`../p8-dev-20261004/`](../p8-dev-20261004/).

## Decision kit guardrails (P0 `eval:decide`, candidate 850e8ef3d vs master 6622a119e)

| Source | Result |
|---|---|
| LME-S dev, recall_all@5 (non-inferiority) | 0.9277 → 0.9277, Δ 0.0000 (n 470) |
| LME-S dev, nDCG@10 (report only) | 0.9429 → 0.9429 |
| N5 forget residue contracts | pass on both builds; prohibited outputs after forget 0, reinstatement 100% |
| N1 knowledge update contracts | pass on both builds |

P8 does not change retrieval; the identical recall is the expected result.

## Write cost (part 1)

LongMemEval-S sessions written as `note` pages through MCP `put_page` on a fresh PGLite brain, one `remember` per
page, background jobs drained with `gbrain jobs work`. 1,000 pages, 10,313 messages, 991 remembered facts, build
ef0de8657, `text-embedding-3-large`.

| Arm | Commit-path generative attempts | Generative calls | $ per 1,000 pages | $ per 1,000 messages | `put_page` p50 / p95 | `remember` p50 / p95 | Job drain |
|---|---|---|---|---|---|---|---|
| Fact extraction on (default) | 0 | 996 (`claude-sonnet-4-6`, facts-absorb) | $11.97 | $1.16 | 80 / 170 ms | 285 / 398 ms | 96 min |
| Fact extraction off | 0 | 0 | $0.32 | $0.03 | 88 / 173 ms | 275 / 378 ms | none queued |

Every model call on a write happens after commit, in the background extraction job. Embedding is the only work on
the write itself. On PGLite the extraction jobs drain about one at a time even with `--concurrency 4`. Two pages per
arm were refused with `revision_conflict` because the session picker gave two sessions the same slug (a harness
issue).

## Semantic withdrawal review (part 2)

Seed A: 150 model-written families (`p8-withdraw-review-gen@1`), 1,050 pairs, about 30% restatements. The conflict
slot was calibrated for the `review_withdraw` call site on the calibrate half and qualified on the eval half
(TypeSafe `jev-1.13.0`).

- Threshold 0.930; on the calibrate half, precision and recall were both 1.000 (n 511).
- Qualification: 77 of 77 families correct over 153 actions. The action precision lower bound is 0.952 (gate 0.90).
  The lane would withdraw 153 of 154 restatements (classifier recall 99%).
- Neighbour retrieval at the 0.80 cosine floor: restatements 99.3%, negations 95.3%, past-tense versions 87.3%,
  compound claims 81.3%, corrected values 39.3%, independent facts 0%. End-to-end recall is about 98%.
- There were no proposals on corrected values, negations, past-tense versions or compound claims.

The caveat: model-written paraphrases are easy. The sealed set adds human-written paraphrases and disjoint names and
values. The kind stays off by default until that set qualifies.

## Quote grounding (part 4)

`gbrain think` (`claude-sonnet-5-5`) on 50 dev questions over amara-life-v1 (35 quote-eliciting, 15 natural). Each
quoted span in what the model wrote is labelled by `gpt-6.1-sol` against the exact evidence the model was given.

| Build | Supported spans | Wrongly flagged | Rate (Wilson 95% upper) | Unsupported spans caught |
|---|---|---|---|---|
| 56a4dbbe2 (first grounding) | 150 | 24 | 16.0% (22.7%) | 1 of 1 real (3 extractor artifacts) |
| 98cae3c98, same answers replayed | 150 | 2 | 1.3% (4.7%) | — |
| 98cae3c98, fresh answers | 151 | 2 | 1.3% (4.7%) | 2 of 2 |

The first run found the real defect. Writers put closing punctuation inside quotation marks ("the deal,"), quoted
from excerpts that end in an ellipsis, and quoted words that sit inside markdown links in the evidence. The fix grounds
the words with edge punctuation and ellipses set aside, and reads `[text](target)` as its text. At the question level
the bound is still wide (2 of 45 questions, upper bound 14.8%); the sealed set is sized for at least 300 supported
spans.

## Advertised tool surface (part 5)

Cat 40 on model-ladder-v1 (not sealed: these tasks shaped earlier releases). The gbrain arm is callable `full` in
every arm, with advertised `full` / `starter` / `verbs`. 25 tasks (5 per family) × 4 models × 1 repeat, uncapped tool
results, build 8f585b0ce.

| Advertised | Success | Δ vs full (95% task-bootstrap interval) | Leaks | Write family (F) | $ | Input tokens | `request_tools` calls |
|---|---|---|---|---|---|---|---|
| full (control) | 90/100 | — | 0 | 20/20 | $38.09 | 30.4M | 0 |
| starter | 92/100 | +2.0 (−2.0, +7.0) | 0 | 20/20 | $29.54 | 14.7M | 0 |
| verbs | 88/100 | −2.0 (−7.0, +3.0) | 0 | 20/20 | $28.24 | 12.8M | 3 |

By model (full / starter / verbs): Sonnet 5.5 22 / 21 / 19, GPT-6.1-sol 24 / 25 / 23, Opus 5.5 22 / 23 / 22,
Fable 5.1 22 / 23 / 24, each out of 25. Misses are in the true-now (B) and evidence (E) families on every arm.

Starter cuts dollars by 22% and input tokens by 52% at no measured success cost. Verbs is within the 3-point bar on
its point estimate, but its interval reaches −7. These tasks have no hidden-tool family, so `request_tools`
discovery is untested here; the sealed world adds one. `NEW_INSTALL_ADVERTISED_SURFACE` stays `full` until the sealed
run decides.

## Spend

About $140 of recorded dev spend, plus one Cat 40 run lost when its VM became unreachable before results were pulled
(an estimated $70 to $110, unrecorded). Recorded: Cat 40 $97.01 (pilot $22.44, rest $74.57), decision kit $14.94,
write cost $12.33, plus quote grounding, family generation and calibration under $15.
