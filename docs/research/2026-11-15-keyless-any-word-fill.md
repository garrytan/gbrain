# Keyless search: fill a short page of results with any-word matches (shipped, 2026-11-15)

- **We learned that on a brain with no embedding provider, filling a short result page with pages that match any of the question's words finds much more of the evidence.** On LongMemEval S, recall_all@10 rose from 80.64% to 91.06%, with 49 questions better and 0 worse.
- **We learned that a new retrieval behaviour should start opt-in, at the callers that can check it.** The first build leaked into every caller of the search function and was closed after review.

## Question

Without embeddings, gbrain's keyword search often returns a short first page because every word must match. Would adding pages that match any word, after the all-words rows, improve recall without disturbing them?

## What was tried

1. **First build** ([#9380](https://github.com/garrytan/gbrain/pull/9380), closed): run the request a second time and append only that run's new pages. A second-model review found three blockers: an alias step could replace a fill row with an unchecked copy and drop safety warnings, the second run's metadata (timeouts, failed checks) was thrown away, and the second run got a fresh time budget.
2. **Second build** ([#9414](https://github.com/garrytan/gbrain/pull/9414), merged as `23a163fc`): the fill runs inside the one search pipeline, only when `search` or `query` ask for it (`anyWordFill`), skips Chinese, Japanese and Korean questions, and has its own timeout cache key.
3. **Benchmark**: LongMemEval S, keyless, 470 scored questions through the `query` operation, master `4244fd77` against the branch. The bar: the response starts with exactly the rows the fill-off response returns.

## Results

| Measure | Before | After | 95% interval |
|---|---|---|---|
| recall_all@10 | 80.64% | 91.06% | +7.87 to +13.19 points |
| recall_all@5 | 72.13% | 81.06% | +6.60 to +11.70 points |
| MRR@10 | 0.8726 | 0.8770 | +0.0011 to +0.0086 |
| Rows that differ from master's first rows | | 0 of 500 questions | |

The fill fired on 103 of 500 questions, costing a median 109 ms (p95 175 ms) through the `query` operation. gbrain-evals reproduced every figure independently at the landed commit and published it in gbrain-evals [#440](https://github.com/garrytan/gbrain-evals/pull/440).

## Decision and why

Shipped in #9414: a large recall gain on keyless brains, no change to existing rows, and a bounded latency cost.

## Cost

About $34 of model use for the first build and about $73 for the second, including its review.

## What would reopen it

- A keyless benchmark where the fill pushes a correct row down, or a latency budget that 175 ms at p95 breaks.
