# Reranker on or off for memory questions (keep, 2026-11-10)

- **We learned that switching the reranker off doesn't clearly help or hurt** on the memory-QA questions where gold sessions ranked just outside the reader's top 5. The diagnostic was underpowered, so the reranker stays on.

## Question

Nightly memory-QA runs showed questions where a gold session ranked 6th to 10th, just past the 5 sessions the reader is given. Was the reranker pushing them down?

## What was tried

A retrieval-only replay at master `001c8c39`: 110 questions from the nightly LongMemEval-S-hard and BEAM-1M-hard sets, reranker on against off, scoring whether all gold sessions reached the reader's 5. 75 questions were eligible (17 couldn't pass within the reader's budget at any ranking, 13 failed the eval suite's support check, 9 were abstention questions).

## Results

| All gold in the reader's 5 | Count |
|---|---|
| On only | 9 |
| Off only | 7 |
| Both | 34 |
| Neither | 25 |

Sign test p = 0.80. By set: LongMemEval-S-hard 3 on-only against 5 off-only, BEAM-1M-hard 6 against 2. Only 16 questions disagreed, and the LongMemEval-S-hard dev set is selected against the reranker by construction, so this can't show a small effect either way.

Source: internal report and notes (refs GST-2359, GBRA-449).

## Decision and why

Keep the reranker on; no change and no default question. The remaining misses are vector-arm order on multi-session questions, with gold at rank 6 to 15.

## Cost

$0.72 of paid API use.

## What would reopen it

- A larger replay with enough disagreeing questions to detect a few points, on a set not selected against the reranker.
