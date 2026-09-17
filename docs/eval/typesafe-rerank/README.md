# TypeSafe reranking: free-account pilot

This completed development evaluation compares Jev 1.13.0 with Voyage rerank-3
on identical frozen synthetic evidence. Both returned every candidate and ranked
the expected approved policy first in all four profiles. It measures reranking,
not final second-brain answers or independently established quality equivalence.
Each provider/profile has **one execution**. All profiles ask the same question;
the fifty-short-document pool repeats nine background documents.

## Results

Captured 2026-09-17T17:08:27.791Z. Only the final selected Jev layout is shown.
Costs sum native reported input across every HTTP call at list prices, excluding
free credits: Voyage USD 0.05/M input; Jev USD 0.042/M input, with free output.
These are nominal costs, not account invoices.

| Documents × characters | Calls Voyage / Jev | Wall ms Voyage / Jev | Active ms Voyage / Jev | Total USD Voyage / Jev |
| --- | --- | --- | --- | --- |
| 10 × 1,000 | 1 / 1 | 768.12 / 977.05 | 768.01 / 977.02 | 0.000086950 / 0.000129108 |
| 5 × 6,000 | 1 / 1 | 388.20 / 585.98 | 388.17 / 585.94 | 0.000250150 / 0.000260736 |
| 50 × 1,000 | 3 / 1 | 1421.50 / 1069.65 | 1420.67 / 1069.64 | 0.000434950 / 0.000599508 |
| 50 × 6,000 | 21 / 2 | 367340.25 / 1582.17 | 7438.43 / 1582.17 | 0.002502400 / 0.002515716 |

Voyage was faster and cheaper on the two smaller profiles. On fifty long
documents, Jev's active elapsed time was 78.7% lower in this execution and
nominal cost was 0.53% higher. Voyage's USD 0.002502400 covers **all 21 calls**;
Jev's USD 0.002515716 covers **both calls**. These points do not establish a
universal winner or latency distributions.

[Individual HTTP table](requests.md), [CSV](requests.csv),
[unaltered receipt](receipt.json), [capture source manifest](source-manifest.json).
All 31 HTTP calls are included. Missing native usage would remain null; request
durations were measured individually, not inferred by dividing totals.

A separate [100-document extension](hundred-document-report.md) captured the
same selected Jev layout on the updated gateway/base, with one execution per
provider/profile and all 54 individual HTTP records. Jev remained 36.50% more
expensive on short documents and 0.53% more expensive on long documents at list
prices. Its active elapsed time on 100 long documents was 86.81% lower in that
single account-constrained execution. The extension preserves the initial
receipt and distinguishes cost per document from total cost.

## Why this differs from the production Voyage adapter

The evaluation selected `voyage:rerank-3` to use this account's free allowance.
GBrain's production default remains `voyage:rerank-2.5`. This account had 3 RPM
and 10,000 TPM. The final campaign did not complete native single-request
comparisons on the fifty-document pools. **Only the evaluation harness** divided
Voyage candidate pools,
scheduled chunks with a shared rolling quota ledger, and added `truncation:false`
to compare the same untrimmed evidence. It permitted up to three concurrent
Voyage calls; native usage settlement and scarce RPM slots determined dispatch.
The production Voyage recipe, wire translation, accounting and failures remain
unchanged. The chunked results are not measurements of that unchanged adapter
receiving the whole large pool in one call. Splitting the fifty-short pool
followed conservative preflight estimates: its 8,699 billed input tokens do not
prove the API admission count, and the pilot did not test whether one full native
request would fit. Necessary chunk counts and optimal scheduling are unproved.

Jev used the proposed production planner/executor: query-only shared state and
one structured Score question per candidate. Fifty short documents fit one
internally parallel request. Fifty long documents packed into 28/22 candidates
and two concurrent requests under one gateway deadline. Conservative context
estimates do not prove these are the smallest possible native request counts.

Wall time runs from first dispatch through complete merged ranking and includes
between-chunk quota gaps. Active time counts the union of gateway intervals plus
planning/merging, excluding idle quota gaps. Initial profile isolation waits are
excluded from both; per-request waits include that preparation. Overlapping
request durations and waits must not be summed as elapsed operation time.

This is an account-constrained collector comparison. Active time still includes
batching, client processing, network and concurrency effects; it does not measure
unconstrained provider inference. Voyage paid-account throughput, maximum Jev
capacity, held-out quality and score-threshold calibration were not established.
Matching gold first does not imply identical rankings or score semantics.

Separate [known-case results](known-case-results.json) retain only the selected
Jev layout's twelve developer-labeled native regression cases, including false
premises, partial/multiple evidence and injected instructions. All predefined
pair checks passed. Current adapter payload hashes reproduce those requests too.
This is a selected-layout extraction of existing evidence, without timing-control
results, held-out labels or a Voyage quality comparison.

## Reproduce

From the repository root, reconstruct the exact evidence, IDs, order and labels:

```bash
bun scripts/fixtures/jev-rerank-workloads.ts .context/jev-workloads.jsonl
bun scripts/typesafe-rerank-ab.ts \
  --pools .context/jev-workloads.jsonl \
  --baseline voyage:rerank-3 --candidate typesafe:jev-1.13.0 \
  --baseline-rpm 3 --baseline-tpm 10000 --baseline-concurrency 3 \
  --baseline-token-margin 1.8 --baseline-max-input-tokens 9040 \
  --baseline-isolate-profiles --repeats 1 --timeout-ms 5000 --max-usd 0.03 \
  --out .context/jev-free-account-ab.json
```

Live execution requires both existing provider environment keys. Add `--dry-run`
for zero-provider-call preflight; it does not report model quality. Quota/token
estimates are recorded heuristics calibrated on development inputs, not provider
tokenizers or guarantees of successful account admission. Use your account's
limits for a different campaign. No retries or equal request-count requirement.
No other native probes or repository checks ran during the captured campaign.

The canonical capped-pool SHA-256 is
`942d24c8eec1b5a70f17a9a0e80a0e5e602e5e7ae4b019e59e6bfc0a968f30a8`.
`test/typesafe-rerank-evidence.test.ts` checks it, complete coverage, native
usage/cost reconciliation and every Jev payload hash against the current adapter.

## Provenance and scope

The unaltered receipt and manifest retain their original local filenames and
capture-base hashes (`668b9bac3`). The generator replaces the original large
JSONL file; the resulting evidence and canonical fingerprint are identical.
The pure Jev planner/executor is unchanged from the captured source. Subsequent
gateway isolation moved only Jev's lifecycle into its own module so the existing
Voyage path could remain intact; the capture is not a fresh timing measurement
on the updated upstream base. Behavioral gateway/search tests cover that wiring.

Primary documentation, checked via curl on 2026-09-17:
[Voyage pricing](https://docs.voyageai.com/docs/pricing),
[Voyage rate limits](https://docs.voyageai.com/docs/rate-limits),
[trial guidance](https://www.mongodb.com/docs/voyageai/api-reference/overview/),
[TypeSafe models](https://docs.typesafe.ai/models),
[System One API](https://docs.typesafe.ai/api),
[Score](https://docs.typesafe.ai/primitives/score).
