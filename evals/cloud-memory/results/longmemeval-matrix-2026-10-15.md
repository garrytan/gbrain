# LongMemEval retrieval matrix — 2026-10-15

**Supported benefit: older cloud history remains retrievable with or without local embeddings.**

With only recent history locally, HydraDB fast recovered every required session for **25/30 questions**, versus **7/30 locally**, both with and without local embeddings. These paired differences pass the predeclared significance rule. The comparison gives HydraDB access to older sessions that the local baseline does not hold; it demonstrates memory availability rather than equal-corpus search superiority.

With the same complete history local, the embedded GBrain baseline recovered every required session for **30/30**, versus **25/30** for HydraDB fast and **23/30** for thinking. Against the full keyless local baseline, fast scored 25/30 versus 22/30, but that improvement was not significant. Thinking showed no retrieval gain over fast and took longer. No general search-quality, answer-accuracy, equivalence or latency advantage is claimed.

## Complete matrix

30 held-out questions, five per category, sampled before retrieval from the pinned `decision430` split using Python `random.Random(20261014)`. None belongs to the earlier development pilot. Full history is 1,427 complete conversation sessions; recent local history is 443 sessions (the newest 30% per question, rounded up). Every cloud condition retains all 1,427 sessions.

Quality uses the first repetition; query latency and fallback/error counts include three repetitions, **90 measurements per condition, 1,080 total**. Session recall counts the required sessions represented among the first ten structured query results; it does not score answers or additional facts present only in Markdown graph context.

| Local history | Local vectors | Backend | Any required session @10 | All required sessions @10 | Gold-session recall | Median / p95 query | Fallbacks / errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Full | Yes | GBrain local | 30/30 | 30/30 | 100.0% | 1243 / 1686 ms | 0 / 0 |
| Full | Yes | HydraDB fast | 29/30 | 25/30 | 87.8% | 831 / 1216 ms | 1 / 0 |
| Full | Yes | HydraDB thinking | 26/30 | 23/30 | 81.6% | 2820 / 4634 ms | 0 / 0 |
| Full | No | GBrain local | 28/30 | 22/30 | 77.6% | 143 / 513 ms | 0 / 0 |
| Full | No | HydraDB fast | 29/30 | 25/30 | 87.8% | 779 / 1010 ms | 0 / 0 |
| Full | No | HydraDB thinking | 27/30 | 24/30 | 83.7% | 2998 / 4650 ms | 0 / 0 |
| Recent ~30% | Yes | GBrain local | 13/30 | 7/30 | 36.7% | 1115 / 1579 ms | 0 / 0 |
| Recent ~30% | Yes | HydraDB fast | 29/30 | 25/30 | 87.8% | 804 / 1204 ms | 0 / 0 |
| Recent ~30% | Yes | HydraDB thinking | 26/30 | 23/30 | 81.6% | 2944 / 5167 ms | 0 / 0 |
| Recent ~30% | No | GBrain local | 12/30 | 7/30 | 30.6% | 128 / 268 ms | 0 / 0 |
| Recent ~30% | No | HydraDB fast | 29/30 | 25/30 | 87.8% | 756 / 981 ms | 0 / 0 |
| Recent ~30% | No | HydraDB thinking | 27/30 | 24/30 | 83.7% | 2893 / 3983 ms | 0 / 0 |

The HydraDB conditions measure the shipped integration, including local fallback. One full-history embedded fast query fell back on the third repetition; it did not affect first-pass quality. All other cloud calls used HydraDB. There were zero operation errors. No-embedding configurations made **zero embedding-provider requests** across all 540 measurements.

## Paired comparisons

The primary metric is all-required-session hit rate @10. The predeclared family covers all 18 comparisons: cloud versus the matching local baseline, thinking versus fast, and local embeddings versus no embeddings. Questions are paired clusters, with 10,000 bootstrap draws and sign-flip randomization draws, seed 20261014. P-values use Holm correction across the whole family. A supported benefit requires a positive delta, a positive lower 95% bootstrap bound, and adjusted p ≤ 0.05. Intervals are individual intervals; adjusted p-values determine the family-level significance gate.

| Baseline → candidate | Difference in all-session hit rate | 95% interval | Holm-adjusted p | Outcome |
| --- | --- | --- | --- | --- |
| `full/embeddings/local` → `full/embeddings/fast` | -16.7 pp | [-30.0, -3.3] pp | 0.7751 | Not significant |
| `full/embeddings/local` → `full/embeddings/thinking` | -23.3 pp | [-40.0, -10.0] pp | 0.1989 | Not significant |
| `full/embeddings/fast` → `full/embeddings/thinking` | -6.7 pp | [-16.7, +0.0] pp | 1.0000 | Not significant |
| `full/no-embeddings/local` → `full/no-embeddings/fast` | +10.0 pp | [-6.7, +26.7] pp | 1.0000 | Not significant |
| `full/no-embeddings/local` → `full/no-embeddings/thinking` | +6.7 pp | [-10.0, +23.3] pp | 1.0000 | Not significant |
| `full/no-embeddings/fast` → `full/no-embeddings/thinking` | -3.3 pp | [-10.0, +0.0] pp | 1.0000 | Not significant |
| `recent/embeddings/local` → `recent/embeddings/fast` | +60.0 pp | [+40.0, +80.0] pp | 0.0018 | Supported benefit |
| `recent/embeddings/local` → `recent/embeddings/thinking` | +53.3 pp | [+30.0, +73.3] pp | 0.0060 | Supported benefit |
| `recent/embeddings/fast` → `recent/embeddings/thinking` | -6.7 pp | [-16.7, +0.0] pp | 1.0000 | Not significant |
| `recent/no-embeddings/local` → `recent/no-embeddings/fast` | +60.0 pp | [+40.0, +80.0] pp | 0.0018 | Supported benefit |
| `recent/no-embeddings/local` → `recent/no-embeddings/thinking` | +56.7 pp | [+36.7, +76.7] pp | 0.0032 | Supported benefit |
| `recent/no-embeddings/fast` → `recent/no-embeddings/thinking` | -3.3 pp | [-10.0, +0.0] pp | 1.0000 | Not significant |
| `full/no-embeddings/local` → `full/embeddings/local` | +26.7 pp | [+13.3, +43.3] pp | 0.0994 | Not significant |
| `full/no-embeddings/fast` → `full/embeddings/fast` | +0.0 pp | [+0.0, +0.0] pp | 1.0000 | Not significant |
| `full/no-embeddings/thinking` → `full/embeddings/thinking` | -3.3 pp | [-10.0, +0.0] pp | 1.0000 | Not significant |
| `recent/no-embeddings/local` → `recent/embeddings/local` | +0.0 pp | [+0.0, +0.0] pp | 1.0000 | Not significant |
| `recent/no-embeddings/fast` → `recent/embeddings/fast` | +0.0 pp | [+0.0, +0.0] pp | 1.0000 | Not significant |
| `recent/no-embeddings/thinking` → `recent/embeddings/thinking` | -3.3 pp | [-10.0, +0.0] pp | 1.0000 | Not significant |

## Controls and scope

- Four independent PGLite databases use identical fixture content and matching UUID revisions for held pages. Vector databases have 6,482/6,482 full-history chunks and 2,070/2,070 recent-history chunks embedded with real `openrouter:openai/text-embedding-3-small` vectors, 1,536 dimensions. Their keyless counterparts have zero vectors, the normal embedding opt-out sentinel, and no embedding-provider key in the gateway.
- No optional local reranker key was provided; local reranking was unavailable in this run.
- Both HydraDB modes use the shipped query request (`query_by: hybrid`, `graph_context: true`, Markdown plus structured evidence), with the existing 2.5-second fast and 15-second thinking deadlines. The runner uses the shipped stdio MCP `query` operation, keeping its readable Markdown and structured results in private raw receipts.
- Expansion, semantic cache and autocut are off, with `limit: 10`, full fields, uncapped snippets and the normal evidence-delivery default. Arm order rotates and reverses. The local gateway is reconfigured between arms, clearing query-embedding reuse; HydraDB internal caching is not controlled. The reported timings describe this protocol and do not compare equal cache behavior or measure CLI startup.
- Gold labels do not enter page titles, slugs or retrieval inputs. Opaque session identities are joined to raw gold IDs only by the scorer. Every query is scoped to its question source. No failed query or difficult question is removed from the sample.
- Setup uploads the production Markdown projection and metadata through production `ingestHydra`, verifying acceptance and completed indexing for all 1,427 documents, with zero skipped documents. Batches contain 50 documents at setup concurrency four. This is not a measurement of normal serial mirror throughput. Setup and embedding time are excluded from query latency. The entire run, including setup and cleanup, took 3,788 seconds; its owned cloud database was deleted.
- This balanced 30-question retrieval sample is not the full 430-question decision set or a reader/judge evaluation. It supports the scoped older-memory finding in this sample. It does not establish broader answer quality, thinking-mode superiority or equal-corpus non-inferiority.

## Reproduction and provenance

[Harness instructions](../README.md) reproduce the preselected sample and every condition. [Aggregate receipt](longmemeval-matrix-2026-10-15.json) records all comparisons and per-category counts. Raw question/session/output rows and credentials are kept outside the repository.

Dataset: [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [cleaned S dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json).

- Dataset SHA-256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Selected-id list SHA-256: `8cd8a2d38b99552ae6e45b88f42baf80d61f09161e288024d21a2091e1d000af`.
- Measured application: `cfe16c9b848b345e817e0a1a032d0d12e0afb4ad`, version `0.60.227.0`; results are not fresh timing claims for subsequent upstream changes.
- Measured harness source is preserved in commit `c9d0f09d7`. The current upload helper shares the production exclusion policy; this public corpus contains no embed-skipped pages and the recorded measurements are unchanged.
- Harness SHA-256 (`ab.ts`, `ingest.ts`, `matrix.ts`, joined with newlines): `cbbee445ce36e381ad4fcddd5961dc3cf807186b1c8b554d7c25cb087fc0c8ef`.
- Run started: `2026-10-14T18:35:43.124Z`; all 1,080 observations and cleanup completed.
