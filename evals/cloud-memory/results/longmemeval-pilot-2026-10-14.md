# LongMemEval retrieval pilot — 2026-10-14

Six development questions: the lexicographically first question per category in
`evals/longmemeval/splits-seed42.json`’s `dev40`. Every category contributes one
question. Each question retains its complete conversation haystack. This is a
small retrieval pilot, with no reader model or answer-accuracy evaluation. It
was measured on the 0.60.223.0 feature implementation before the subsequent
upstream cold-start/engine merge; it is not a fresh timing claim for that merge.

Full corpus: **285 sessions**. Reduced local corpus: **89 sessions**,
the most recent 30% per question, rounded up. HydraDB retains the full corpus.

| Local history | Selected backend | Any required session @10 | All required sessions @10 | Gold-session recall | p50 / p95 query latency | Local fallbacks |
| --- | --- | --- | --- | --- | --- | --- |
| Full | GBrain hybrid | 6/6 | 6/6 | 100% | 224 / 5762 ms | 0/18 |
| Full | HydraDB fast enabled | 6/6 | 5/6 | 90% | 1002 / 3017 ms | 1/18 |
| Recent ~30% | GBrain hybrid | 1/6 | 1/6 | 10% | 197 / 2662 ms | 0/18 |
| Recent ~30% | HydraDB fast enabled | 4/6 | 4/6 | 70% | 803 / 3254 ms | 3/18 |

“HydraDB enabled” measures the shipped integration, including its local fallback.
The full-history HydraDB arm fell back on one first-pass question; the reduced
arm fell back on two first-pass questions and once in a repetition. The log
records an invalid-response warning and a query timeout; per-call failure
causes were not recorded. The fast-mode request budget was 2.5 seconds. Results
must not be described as pure HydraDB retrieval scores.

The reduced-local result demonstrates access to older cloud memory: the selected
backend raised required-session hit rate from 1/6 to 4/6. It compares different
available corpora. With the complete corpus local, both configurations hit a
required session for all six questions, while GBrain recovered every required
session for six questions versus five with HydraDB enabled. HydraDB adds a
network round trip; this pilot does not establish a general search-quality or
latency advantage.

Quality uses the first repetition; latency and fallback counts use all three
repetitions (18 measurements per condition). Backend order alternates. Metrics
count required sessions represented in up to ten returned query results. Default
evidence delivery can expand local conversations, so this compares the actual
query pipelines rather than enforcing identical passage segmentation.

Local embedding model: `openrouter:openai/text-embedding-3-small`, 1536 dimensions;
all local chunks had embeddings before evaluation. GBrain query expansion,
semantic cache and autocut were disabled. HydraDB was queried with `mode: fast`,
`query_by: hybrid` and `graph_context: true`; its internal caching was not
controlled. Page slugs and titles use opaque session identities; gold labels
are joined only by the scorer. Queries are scoped to each question’s source.

The cloud backfill verified 285 uploads, with zero skipped pages. The successful
run took 1756 seconds including setup/indexing, which is excluded from query
latency. Earlier 12-question and 6-question attempts exceeded a 10-minute batch
indexing wait; the completed run allowed 30 minutes per batch. Disposable cloud
databases were deleted after every attempt. Raw question/output rows remain
outside the repository; this artifact contains only aggregate measurements.

Dataset: [LongMemEval](https://github.com/xiaowu0162/LongMemEval),
[cleaned S download](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json).

Dataset SHA-256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

Reproduce using the [harness instructions](../README.md), taking the first **one**
question per category instead of two (`[:1]` in the selector), with `--k 10`,
`--local-share 0.3` and `--repeats 3`. Fast is the default; thinking is separately
available through `gbrain cloud mode thinking` and was live-smoke-tested.

A larger held-out sample, uncertainty estimates and a reader-model evaluation
are required for broader performance claims.
