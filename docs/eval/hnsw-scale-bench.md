# HNSW vector search at production scale (E5.4.1, E5.4.2)

gbrain's Postgres vector arm finds unfiltered and broadly filtered neighbours well from 250k to 2M chunks.
After this wave's two fixes, it also does so under selective random scopes and right after a bulk load.

**Fix 1: scoped search scans deeper.** Every pooled attempt now visits up to 20,000 index tuples
(`POOL_MAX_SCAN_TUPLES` in `src/core/search/vector-pool.ts`, pgvector's own `hnsw.max_scan_tuples` default).
Before, the first attempt stopped at 2,000. Under a 10% source or visibility scope, that budget found about
200 eligible chunks. That covered enough pages to be accepted, but it was too shallow to hold the true
neighbours. The deeper scan has these effects:
- **Synthetic, 1M and 2M chunks, same database, `limit 50`:** 10%-scope recall@50 rises from 0.52–0.63 to
  0.96–0.99, and recall@10 from 0.92 to 0.98–0.99.
- **1M real voyage-4 chunks, random 10% scope:** recall@50 goes from 0.77 to 0.97.
- **Cost:** 16 to 36 ms more p50 per scoped search.
- **Unscoped searches** return identical results.

**Fix 2: statistics follow bulk writes.** Import, sync, reindex and embed drains now analyze
`content_chunks(model, modality, page_id)` and the page columns search filters read. Without those
statistics, the pooled statement sorted every eligible chunk instead of walking the index. At 1M to 2M
chunks that ran past the 8 s budget on 44% to 100% of 50%-scoped searches. In the post-import statistics
state, 1M and 2M chunks now plan on HNSW with no incomplete results.

**One gap remains: large topic-coherent scopes.** Take a source that is a tenth of the brain and made
of whole topic clusters, here 104,000 real chunks. Most queries come from other topics, so the nearest
in-scope chunks sit outside the region an HNSW scan reaches. On top of v0.60.131.0's exact scope scan,
which covers sources up to 60,000 chunks, this PR lifts that source's recall@50 from 0.66 to 0.76. Raising
the scan cap to 150,000 chunks makes it exact (0.985) at about 770 ms p50; that is proposed below, not
shipped.

Since v0.60.134.0 the scan cap is 120,000 counted chunks (`SCOPE_CHUNKS_SQL`), so a 104,000-chunk
source like this one takes the exact scan. The measurements below predate that change.

Index build options don't change any of this, so the defaults stay (m 16, ef_construction 64, `vector`).
`ef_construction` 128 adds about 0.02 to 0.03 unfiltered recall@10 for about 25% more build time.
`halfvec` gives the same recall with an index a third the size (5.1 GiB against 15.3 GiB at 2M chunks).

The numbers come from three sources:
- synthetic-latent vectors at voyage-4's 1,024 dimensions (`src/core/ai/recipes/voyage.ts`, `default_dims: 1024`),
  from 250k to 2M chunks;
- a 1M-chunk English Wikipedia corpus embedded with voyage-4, which cost $13.07 by the API's own token counts;
- 100 queries per cell, on Ubicloud standard-16 VMs.

## On top of the exact scope scan (v0.60.131.0)

v0.60.131.0 scans a source scope exactly when it holds under 30% of pages and at most about 60,000 chunks.
For a larger source it widens the index walk to the scope's share. So the pooled budget matters only where
search still reaches the pool:
- visibility-only scopes;
- type or date filters, which skip the walk;
- sources too large for the exact scan whose walk comes back short;
- scopes with no chunk statistics.

Both arms were measured with v0.60.131.0, with and without the 20,000-tuple pooled budget, at shipped
`ef_search` and VACUUM ANALYZEd:
- **Synthetic sweep:** each arm loads the corpus itself, so rows carry about ±0.02 build variance (unscoped
  recall@10 moved 0.04 at 1M between the two loads with identical code paths).
- **Real corpus:** both arms run on one database, so they share a build.

| corpus | scope | #6378 recall@10 / @50 | + pooled budget recall@10 / @50 | #6378 p50 @50 ms | + budget p50 @50 ms |
|---|---|---|---|---|---|
| 50k pages (352k chunks) | visibility 10% (random) | 0.877 / 0.736 | 0.991 / 0.993 | 45.8 | 51.9 |
| 50k pages (352k chunks) | visibility 50% (random) | 0.978 / 0.917 | 0.993 / 0.962 | 40.5 | 41.1 |
| 50k pages (352k chunks) | source 10% | 0.987 / 0.974 | 0.991 / 0.991 | 100.9 | 88.5 |
| 50k pages (352k chunks) | source 30% | 0.987 / 0.860 | 0.992 / 0.985 | 31.2 | 44.9 |
| 50k pages (352k chunks) | source 55% | 0.987 / 0.950 | 0.991 / 0.994 | 21 | 34.1 |
| 1M chunks | visibility 10% (random) | 0.888 / 0.615 | 0.988 / 0.984 | 33.6 | 51.6 |
| 1M chunks | visibility 50% (random) | 0.939 / 0.956 | 0.989 / 0.974 | 32.1 | 35.7 |
| 1M chunks | source 1.1% | 1.000 / 1.000 | 1.000 / 1.000 | 67.6 | 68.9 |
| 1M chunks | source 4% | 0.912 / 0.969 | 0.910 / 0.968 | 159.8 | 136.1 |
| 1M chunks | source 4% + type | 1.000 / 1.000 | 1.000 / 1.000 | 226.2 | 224.3 |
| 1M chunks | source 10% | 0.974 / 0.834 | 0.972 / 0.818 | 69.6 | 70.7 |
| 1M chunks | source 10% + type | 0.878 / 0.601 | 0.979 / 0.979 | 21.8 | 40.2 |
| 1M chunks | source 30% | 0.981 / 0.845 | 0.983 / 0.942 | 29.3 | 37.6 |
| 1M chunks | source 55% | 0.971 / 0.978 | 0.973 / 0.988 | 30.7 | 31.3 |
| 1M chunks | unscoped | 0.938 / 0.990 | 0.977 / 0.991 | 16.3 | 15.8 |

The budget adds recall wherever the pool runs: random visibility scopes (recall@50 0.62–0.74 to 0.98–0.99),
a source scope plus a type filter above the exact scan's cap (0.60 to 0.98), and 30% to 55% sources
(0.85–0.95 to 0.94–0.99). It costs 1 to 18 ms p50. Where the exact scan or a full walk answers, the pool
never runs and the two arms agree within build variance, as with small sources and the 10% source of 1M
without a type filter.

That last row is a finding for the walk, not for this change. A 10% source of 1M chunks (100,000 chunks)
is above the scan cap, so it gets the share-scaled walk. The walk fills its window, but with a relaxed
scan of moderate quality, and recall@50 stays at 0.82–0.83 on both arms. The lever is the walk's own
budget or `ef_search`, or the scan cap below.

1M voyage-4 Wikipedia chunks, one database:

| scope (1M voyage-4 chunks) | #6378 recall@10 / @50 (p50 @50) | + pooled budget | + budget, scope-scan cap 150,000 |
|---|---|---|---|
| unscoped | 0.970 / 0.982 (29.1 ms) | 0.970 / 0.982 (32.5 ms) | 0.970 / 0.982 (35.3 ms) |
| topic-coherent 10% source (104k chunks) | 0.658 / 0.655 (152.9 ms) | 0.836 / 0.758 (188.6 ms) | 0.993 / 0.985 (767.8 ms) |
| same + type filter | 0.633 / 0.614 (39.7 ms) | 0.832 / 0.764 (79.5 ms) | 1.000 / 1.000 (832.3 ms) |
| topic-coherent 50% source | 0.874 / 0.870 (52.8 ms) | 0.961 / 0.954 (48.7 ms) | 0.961 / 0.954 (56.8 ms) |
| random 10% visibility | 0.910 / 0.767 (64 ms) | 0.989 / 0.969 (88.7 ms) | 0.989 / 0.969 (93.7 ms) |
| random 50% visibility | 0.956 / 0.945 (47.7 ms) | 0.965 / 0.972 (47 ms) | 0.965 / 0.972 (47.6 ms) |

On real vectors the budget lifts every scoped bucket the pool reaches. The topic-coherent 10% source has
104,000 chunks, past the 60,000-chunk scan cap. Raising `SCOPE_SCAN_MAX_CHUNKS` to 150,000 makes that
source exact (recall@50 0.985) at about 770 ms p50 on this 16-vCPU host. That is the remaining gap's price;
it is proposed in "Recommendations", not shipped.

In the post-import statistics state, v0.60.131.0 without this PR's statistics refresh sorts every
eligible chunk. At 1M chunks those searches take 0.5 to 8 s, and 42% to 50% of 50% to 55% scopes come
back incomplete. Their recall is near 1.0 because the sort is exact. With the refresh they plan on HNSW at
8 to 70 ms p50, with the recall of the tables above.

## Decision rule

The plan's rule (E5.4.1): keep defaults unless recall@10 < 0.95 or underfill > 1% at the shipped `ef_search`.
The shipped code failed it. On master, 10%-scope recall@10 was 0.886 to 0.950 synthetic and 0.63 to 0.92 real.
Stats-less loads made 44% to 100% of 50%-scoped searches incomplete.

The plan's proposed remedy, a per-brain `search.hnsw_ef_search_floor` knob, was measured and rejected.
On real vectors, `ef_search` 1,000 left topic-scoped recall@50 at 0.71 and random 10% at 0.93. Fix 1
reaches 0.97 on the random scope at the shipped `ef_search`. So no knob ships.

After both fixes:

| check (shipped settings) | synthetic 1M / 2M | real 1M | verdict |
|---|---|---|---|
| unfiltered recall@10 | 0.972 / 0.935 | 0.968 | 2M below 0.95 on this load (0.965 on the first load); build variance, the same before and after |
| random 10% visibility recall@10 | 0.989 / 0.979 | 0.990 | pass |
| 10% source recall@10 | 0.986 / 0.990 (random) | 0.837 (topic-coherent) | pass random; **fail** topic-coherent |
| 50% source / visibility recall@10 | 0.981 / 0.928–0.941 | 0.959 / 0.967 | pass except 2M synthetic (0.93 to 0.94, unchanged by either fix) |
| incomplete, post-import statistics | 0% / 0% | not measured | pass |

The 2M synthetic unfiltered and 50%-scope recall@10 sit at 0.93 to 0.94 on this load and at 0.965 to 0.978
on the first load of the same corpus. HNSW graph variance between builds explains the difference, and
neither fix touches it. `ef_construction` 128 measured 0.981 there (E5.4.2 below).

## Fix 1: which mechanism

The two options were to start pooled attempts at 20,000 tuples, or to keep 2,000 and refuse a short window
(escalate, or run the exact fallback, while `hasMore` says more eligible rows exist). Both were measured on
the same database, after the same index build, against master. Escalate-when-short keeps master's
2,000 × 4^n schedule. Its window stays short at every step, so it ends in the exact fallback: 1.0 to
8.5 s per search, and incomplete when that misses the 8 s budget. The deeper first scan wins at equal or
better recall everywhere except topic-coherent 10% scopes, where only exact search gets past 0.84. There
the trade is about 1.5 s per search, which is a product decision.

Synthetic-latent corpus (shipped `ef_search`, relaxed_order, 100 queries; recall@k at `limit k`):

| chunks | filter | k | master recall@k | escalate-when-short | fixed (20,000) | master p50 / p95 ms | escalate p50 / p95 ms | fixed p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|
| 1M | none | 10 | 0.972 | 0.972 | **0.972** | 17.9 / 23 | 15.9 / 23.2 | 9.7 / 12.1 |
| 1M | none | 50 | 0.990 | 0.990 | **0.990** | 27.7 / 32.8 | 22.7 / 29.3 | 19.9 / 23.8 |
| 1M | source10 | 10 | 0.922 | 0.922 | **0.986** | 29 / 36.4 | 25.3 / 32.4 | 27.6 / 36.9 |
| 1M | source10 | 50 | 0.612 | 0.747 | **0.986** | 36.7 / 44.6 | 39.5 / 1342.8 | 54 / 62.5 |
| 1M | vis10 | 10 | 0.924 | 0.924 | **0.989** | 24.5 / 31.9 | 27.3 / 32.2 | 31.5 / 40.5 |
| 1M | vis10 | 50 | 0.631 | 0.715 | **0.983** | 40.1 / 104.5 | 49.3 / 8471.6 | 56 / 64.4 |
| 1M | source50 | 10 | 0.981 | 0.981 | **0.981** | 11.1 / 18.9 | 13.2 / 25.8 | 10.2 / 19.6 |
| 1M | source50 | 50 | 0.970 | 0.970 | **0.975** | 37.4 / 93.2 | 39.2 / 93.3 | 40.7 / 93.9 |
| 1M | vis50 | 10 | 0.981 | 0.981 | **0.981** | 13.3 / 24.3 | 13.2 / 23.8 | 13.4 / 22.9 |
| 1M | vis50 | 50 | 0.959 | 0.959 | **0.973** | 37.9 / 100.5 | 38.7 / 92.8 | 38.4 / 97.4 |
| 2M | none | 10 | 0.935 | 0.935 | **0.935** | 16 / 23.4 | 15.8 / 26 | 13.6 / 66.5 |
| 2M | none | 50 | 0.981 | 0.981 | **0.981** | 21.2 / 27 | 22.2 / 36.2 | 17.8 / 24.3 |
| 2M | source10 | 10 | 0.921 | 0.921 | **0.990** | 22.3 / 26.7 | 23 / 29.2 | 28.1 / 182.7 |
| 2M | source10 | 50 | 0.560 | 0.646 | **0.958** | 38.6 / 119.7 | 38.5 / 142 | 74.6 / 320.8 |
| 2M | vis10 | 10 | 0.915 | 0.915 | **0.979** | 23.5 / 27.2 | 22.7 / 25.6 | 29.1 / 41.3 |
| 2M | vis10 | 50 | 0.518 | 0.669 | **0.957** | 37.9 / 43.4 | 143.3 / 8592 | 63.5 / 125.7 |
| 2M | source50 | 10 | 0.928 | 0.928 | **0.928** | 16 / 20.2 | 16.2 / 22.6 | 15.6 / 24.1 |
| 2M | source50 | 50 | 0.962 | 0.962 | **0.979** | 28.9 / 90 | 28.3 / 104 | 28 / 102.2 |
| 2M | vis50 | 10 | 0.936 | 0.936 | **0.941** | 19.4 / 23.8 | 18.6 / 23.6 | 19.2 / 24.9 |
| 2M | vis50 | 50 | 0.963 | 0.963 | **0.981** | 31.8 / 84.7 | 32 / 86.5 | 32.4 / 114.5 |

1M voyage-4 Wikipedia chunks. The source scopes are topic-coherent: whole k-means clusters fill 10.4% and
50.5% of chunks. The visibility scopes are random. Recall@10 inside the `limit 50` call is in parentheses:

| filter | k | master recall@k (@10 in call) | fixed recall@k (@10 in call) | escalate-when-short | master p50 / p95 ms | fixed p50 / p95 ms | escalate p50 / p95 ms |
|---|---|---|---|---|---|---|---|
| none | 10 | 0.968 (0.968) | **0.968** (0.968) | 0.968 | 12.9 / 19.9 | 11.5 / 21.3 | 17.3 / 31.5 |
| none | 50 | 0.981 (0.984) | **0.981** (0.984) | 0.981 | 23.4 / 38.9 | 22.8 / 27.8 | 25.7 / 32.4 |
| topic 10% (source) | 10 | 0.629 (0.629) | **0.837** (0.837) | 0.956 | 30.8 / 169.3 | 61.9 / 101.9 | 1577.9 / 1779.8 |
| topic 10% (source) | 50 | 0.638 (0.813) | **0.777** (0.889) | 0.955 | 50 / 1087 | 91 / 1078.1 | 1027.2 / 1138.9 |
| topic 50% (source) | 10 | 0.875 (0.875) | **0.959** (0.959) | 0.905 | 14 / 24.5 | 19 / 58.9 | 19.1 / 83.5 |
| topic 50% (source) | 50 | 0.852 (0.908) | **0.951** (0.974) | 0.913 | 29.5 / 47 | 42.7 / 97 | 31.2 / 6857.4 |
| random 10% (visibility) | 10 | 0.916 (0.916) | **0.990** (0.990) | 0.916 | 24.9 / 29.5 | 42.4 / 58.5 | 25 / 27.6 |
| random 10% (visibility) | 50 | 0.765 (0.939) | **0.970** (0.994) | 0.809 | 40.8 / 48.7 | 73 / 87.4 | 47.8 / 6535.8 |
| random 50% (visibility) | 10 | 0.957 (0.957) | **0.967** (0.967) | 0.957 | 13.6 / 24.9 | 18.4 / 32.5 | 14.4 / 24.1 |
| random 50% (visibility) | 50 | 0.945 (0.978) | **0.971** (0.986) | 0.945 | 30.7 / 41.6 | 37.9 / 58.1 | 32 / 43.6 |

At 1M real chunks, pinning 50,000 or 100,000 tuples on top of fix 1 gave the same recall to three
decimals in every cell. The topic-coherent gap is not a scan budget.

## Fix 2: statistics

`refreshProjectionStatistics` (`src/core/search/projection-statistics.ts`) used to run
`ANALYZE pages(text_projection_revision, knowledge_revision)` only. That is what import, sync, reindex and
projection recovery end with. On Postgres it now runs two steps:
1. `ANALYZE pages(text_projection_revision, knowledge_revision, deleted_at, source_id, type, slug)`.
2. `ANALYZE content_chunks(model, modality, page_id)`, in the same transaction (30 s statement and 2 s lock
   timeouts) behind a savepoint, so a concurrent index build only skips this step, with a warning that
   names the command.

An embed drain that embedded anything also runs step 2 once at its end. Both halves are needed:
- `content_chunks` alone still sorts, because `p.deleted_at IS NULL` is priced at 0.5% and the planner
  drives from a few pages.
- `pages(deleted_at)` alone still sorts on the chunk filters.

`test/e2e/vector-chunk-statistics-postgres.test.ts` proves both on a 12,000-chunk fixture: the stats-less
plan misses `idx_chunks_embedding`, and the refreshed plan uses it. That test fails on master.

The same synthetic corpora loaded with the fixed code, after only the refresh that import and sync run
(`--states projection`), give these results:

| chunks | filter | k | recall@k | p50 ms | p95 ms | incomplete | pooled plan |
|---|---|---|---|---|---|---|---|
| 1M | none | 50 | 0.990 | 20.3 | 23.7 | 0% | HNSW, 13 ms |
| 1M | source10 | 50 | 0.986 | 56.5 | 65.3 | 0% | HNSW, 20 ms |
| 1M | vis50 | 50 | 0.980 | 38.1 | 90.1 | 0% | HNSW, 9 ms |
| 2M | none | 50 | 0.990 | 56.2 | 71.9 | 0% | HNSW, 11 ms |
| 2M | source10 | 50 | 0.958 | 100.1 | 126.8 | 0% | HNSW, 22 ms |
| 2M | vis50 | 50 | 0.986 | 39.5 | 173.3 | 0% | HNSW, 10 ms |

Before the fix, the same state at 250k sorted every candidate and hit the 8 s budget (57% incomplete,
unfiltered, k=50; "Statistics states and EXPLAIN" below). In the fully stats-less state at 1M and 2M,
50%-scoped searches were 44% to 100% incomplete.

## Recommendations (proposed, not shipped)

1. **Raise the exact scope scan's cap for large topic-coherent sources, after measuring it.** v0.60.131.0
   scans a source exactly up to `SCOPE_SCAN_MAX_CHUNKS` (60,000). On 1M real chunks, a 104,000-chunk
   topic-coherent source gets recall@50 0.76 through the walk and the pool. At a 150,000 cap the exact scan
   gets 0.985, at about 770 ms p50 on 16 vCPU. That trades latency for recall on large sources, and that
   module is changing under a planned exact per-scope chunk count. So it is a decision for that work, made
   with this bench (`--corpus dir`, `--source-shares`).
2. **Keep the index defaults (m 16, ef_construction 64, `vector`).** Measured candidates for a later
   migration: `halfvec` for size (a third of the index, about 1.4x faster build, same recall), and
   `ef_construction` 128 for about +0.02 to 0.03 unfiltered recall@10 at 1M and 2M.
3. **Size `maintenance_work_mem` for the deferred ANN build.** `buildDeferredAnnIndexes`
   (`src/core/embedding-ann-build.ts`) builds with the server's `maintenance_work_mem`. At 250k chunks,
   256 MB with 2 workers took 103 s against 24 s with 4 GB and 8 workers, after pgvector reported
   `hnsw graph no longer fits into maintenance_work_mem after 55308 tuples`. `docs/ENGINES.md`
   ("Vector index sizing") now gives the operator the sizing rule and the commands.

The sections below record the pre-fix measurement of master (E5.4.1) and the build options (E5.4.2), which
led to the fixes above.

## What was measured

**Query path.** Every cell calls `PostgresEngine.searchVector`, the vector arm hybrid search runs. That
means `buildVectorSearchStatement`, the index walk (`searchIndexWalk`), the pooled statement with its
escalations, `hasMore`, the exact fallback, `withVectorSettings`, `hnswEfSearchFor`, the
`relaxed_order` iterative scan and the 8 s deadline. The bench wraps the engine's private
`runVectorAttempt` and records which attempts ran. For pinned cells it also sets `hnsw.ef_search` (or
`hnsw.max_scan_tuples`) inside the engine's transaction, after the engine's own settings. Shipped cells
make the same extra round trip with a no-op value. "shipped" means the engine's own sizing:
`ef_search` = the attempt window, so 200 or 500 for the index walk at limit 10 or 50, and 100 or 250 for
the first pooled attempt, ×4 per escalation.

**Metrics.**
- **recall@k:** page recall against an exact per-page max-pooled ranking under the same filter.
- **recall@10 in the call:** the first 10 results of a `limit 50` call.
- **short:** fewer results than `min(k, eligible pages)`.
- **incomplete:** `onVectorPoolMeta` fired; hybrid turns this into `vector_candidates_incomplete`.
- **served by index walk:** the walk answered alone.
- **mean attempts:** statements per search.

Hybrid search calls the vector arm with `limit` = `min(max(limit×2, 50), 100)`, so the `k = 50` rows are
the realistic ones.

**Truth.** Exact top 100 pages per query and filter, computed in float64 from the exact float4 values
loaded. 15 queries per corpus (3 per filter) were checked against gbrain's own `exactSql`, and all 15
matched in identical order at every size.

**Filters.**
- **sourceN:** `sourceIds` covering N% of pages.
- **visN:** `excludePrivate: true` with (100-N)% of pages `visibility: private`.

Assignment is independent of topic.

**Corpus** (`scripts/bench/hnsw-latent-corpus.ts`). Each chunk is a unit vector built from four parts:
a shared mean direction, a super-topic and a topic direction, a rank-16 topic subspace (page plus chunk
coefficients), and isotropic noise. Topics grow as 4·sqrt(pages). Each page holds 1 to 60 chunks (mean 7.0)
of about 1,500 characters of text. A query is a random chunk moved within its subspace, with fresh noise.

| chunks | pages | topics | LID (MLE, k=20) median [p10, p90] | cos random pair | same topic | same page | query to source chunk | query to top-1 |
|---|---|---|---|---|---|---|---|---|
| 250k | 35,588 | 730 | 14.6 [10.3, 19.2] | 0.174 | 0.492 | 0.725 | 0.789 | 0.790 |
| 1M | 141,871 | 1,461 | 16.5 [11.7, 22.9] | 0.179 | 0.478 | 0.725 | 0.792 | 0.793 |
| 2M | 284,410 | 2,066 | 17.2 [12.9, 25.7] | 0.179 | 0.488 | 0.722 | 0.790 | 0.793 |
| 1M "hard" (rank 32, noise ×2) | 142,609 | 1,461 | 18.2 [12.7, 25.8] | 0.158 | 0.415 | 0.658 | 0.750 | 0.751 |

On disk at 2M (after VACUUM ANALYZE), `content_chunks` takes 32 GB including its indexes. That is
2.8 GB of heap, 13 GB of TOAST (vectors are stored out of line) and the 15.3 GiB HNSW index.

**Server.** Ubicloud standard-16 (16 vCPU, 64 GB RAM, 320 GB disk), `pgvector/pgvector:pg16`
(PostgreSQL 16.15, pgvector 0.8.7) in Docker, client on the same VM, one client, warm cache. Settings
come from `scripts/bench/hnsw-scale-vm-setup.sh`: shared_buffers 16 GB, effective_cache_size 48 GB,
random_page_cost 1.1, effective_io_concurrency 200, work_mem 4 MB, jit on (gbrain's read transaction
turns it off). Default builds use maintenance_work_mem 4 GB, 12 GB or 20 GB by size, with 8 parallel
maintenance workers and `CREATE INDEX CONCURRENTLY`, as the deferred ANN build does. Production adds
network round trips: about 7 per attempt by the code path (BEGIN, settings read, settings write,
timeout, statement, settings restore, COMMIT; counted from the code, not measured), with 2 attempts on a
filtered search.

## E5.4.1 results on the pre-fix code

### A. Recall by `ef_search`, VACUUM ANALYZEd

relaxed_order. The 40 to 400 and shipped columns share one index build. The 800 and 1000 columns come from a second load of the same corpus (`sweep-*`), so they also carry build-to-build variance of about ±0.02.

| chunks | filter | k | 40 | 100 | 200 | 400 | 800 | 1000 | shipped | recall@10 in the call (shipped) |
|---|---|---|---|---|---|---|---|---|---|---|
| 250k | none | 10 | 0.963 | 0.974 | 0.974 | 0.994 | 0.990 | 0.990 | **0.974** | 0.974 |
| 250k | none | 50 | 0.943 | 0.967 | 0.973 | 0.993 | 0.997 | 0.997 | **0.995** | 0.995 |
| 250k | source10 | 10 | 0.856 | 0.886 | 0.908 | 0.952 | 0.983 | 0.990 | **0.886** | 0.886 |
| 250k | source10 | 50 | 0.733 | 0.739 | 0.786 | 0.854 | 0.938 | 0.979 | **0.798** | 0.934 |
| 250k | source50 | 10 | 0.964 | 0.974 | 0.974 | 0.993 | 0.998 | 0.998 | **0.974** | 0.974 |
| 250k | source50 | 50 | 0.893 | 0.911 | 0.927 | 0.961 | 0.991 | 0.994 | **0.947** | 0.994 |
| 250k | vis50 | 10 | 0.965 | 0.975 | 0.975 | 0.995 | 0.997 | 0.997 | **0.975** | 0.975 |
| 250k | vis50 | 50 | 0.885 | 0.901 | 0.922 | 0.958 | 0.992 | 0.995 | **0.941** | 0.996 |
| 250k | vis10 | 10 | 0.882 | 0.899 | 0.916 | 0.954 | 0.988 | 0.993 | **0.899** | 0.899 |
| 250k | vis10 | 50 | 0.706 | 0.739 | 0.792 | 0.856 | 0.953 | 0.969 | **0.813** | 0.947 |
| 1M | none | 10 | 0.963 | 0.963 | 0.963 | 0.980 | 0.987 | 0.987 | **0.963** | 0.963 |
| 1M | none | 50 | 0.973 | 0.982 | 0.982 | 0.993 | 0.993 | 0.993 | **0.992** | 0.981 |
| 1M | source10 | 10 | 0.901 | 0.912 | 0.924 | 0.952 | 0.958 | 0.979 | **0.912** | 0.912 |
| 1M | source10 | 50 | 0.541 | 0.564 | 0.604 | 0.672 | 0.691 | 0.800 | **0.614** | 0.939 |
| 1M | source50 | 10 | 0.969 | 0.969 | 0.969 | 0.990 | 0.987 | 0.987 | **0.969** | 0.969 |
| 1M | source50 | 50 | 0.938 | 0.950 | 0.956 | 0.981 | 0.982 | 0.989 | **0.961** | 0.983 |
| 1M | vis50 | 10 | 0.965 | 0.966 | 0.966 | 0.983 | 0.986 | 0.986 | **0.966** | 0.966 |
| 1M | vis50 | 50 | 0.938 | 0.946 | 0.954 | 0.979 | 0.980 | 0.987 | **0.958** | 0.975 |
| 1M | vis10 | 10 | 0.916 | 0.929 | 0.943 | 0.966 | 0.964 | 0.980 | **0.929** | 0.929 |
| 1M | vis10 | 50 | 0.525 | 0.558 | 0.593 | 0.666 | 0.694 | 0.798 | **0.626** | 0.943 |
| 2M | none | 10 | 0.945 | 0.965 | 0.965 | 0.973 | 0.974 | 0.976 | **0.965** | 0.965 |
| 2M | none | 50 | 0.956 | 0.977 | 0.977 | 0.978 | 0.988 | 0.989 | **0.977** | 0.973 |
| 2M | source10 | 10 | 0.928 | 0.950 | 0.954 | 0.959 | 0.970 | 0.970 | **0.950** | 0.950 |
| 2M | source10 | 50 | 0.490 | 0.511 | 0.547 | 0.589 | 0.690 | 0.676 | **0.558** | 0.954 |
| 2M | source50 | 10 | 0.951 | 0.975 | 0.975 | 0.978 | 0.978 | 0.980 | **0.975** | 0.975 |
| 2M | source50 | 50 | 0.949 | 0.974 | 0.977 | 0.979 | 0.991 | 0.991 | **0.977** | 0.978 |
| 2M | vis50 | 10 | 0.952 | 0.978 | 0.978 | 0.982 | 0.984 | 0.988 | **0.978** | 0.978 |
| 2M | vis50 | 50 | 0.952 | 0.974 | 0.977 | 0.980 | 0.991 | 0.992 | **0.979** | 0.981 |
| 2M | vis10 | 10 | 0.929 | 0.950 | 0.957 | 0.961 | 0.966 | 0.976 | **0.950** | 0.950 |
| 2M | vis10 | 50 | 0.482 | 0.507 | 0.549 | 0.583 | 0.676 | 0.657 | **0.565** | 0.957 |

### B. Shipped settings: latency and failure signals

| chunks | filter | k | recall@k | p50 ms | p95 ms | p99 ms | short | incomplete | served by index walk | mean attempts |
|---|---|---|---|---|---|---|---|---|---|---|
| 250k | none | 10 | 0.974 | 7.9 | 15.8 | 20.8 | 0% | 0% | 100% | 1 |
| 250k | none | 50 | 0.995 | 49 | 56 | 61.8 | 0% | 0% | 42% | 2.16 |
| 250k | source10 | 10 | 0.886 | 16.1 | 18.6 | 34.8 | 0% | 0% | 0% | 2.01 |
| 250k | source10 | 50 | 0.798 | 28.9 | 314.3 | 325 | 0% | 0% | 0% | 2.31 |
| 250k | source50 | 10 | 0.974 | 13.3 | 22.4 | 26.6 | 0% | 0% | 43% | 1.57 |
| 250k | source50 | 50 | 0.947 | 21.1 | 51.7 | 57.2 | 0% | 0% | 36% | 1.72 |
| 250k | vis50 | 10 | 0.975 | 10.7 | 18.7 | 23.6 | 0% | 0% | 51% | 1.49 |
| 250k | vis50 | 50 | 0.941 | 26.2 | 34.2 | 63.2 | 0% | 0% | 40% | 1.64 |
| 250k | vis10 | 10 | 0.899 | 18.5 | 30.2 | 41.9 | 0% | 0% | 0% | 2.01 |
| 250k | vis10 | 50 | 0.813 | 30.1 | 135.2 | 149.3 | 0% | 0% | 0% | 2.36 |
| 1M | none | 10 | 0.963 | 12.6 | 18.9 | 21.6 | 0% | 0% | 100% | 1 |
| 1M | none | 50 | 0.992 | 15 | 26.2 | 38.1 | 0% | 0% | 100% | 1 |
| 1M | source10 | 10 | 0.912 | 17.9 | 26.9 | 44.1 | 0% | 0% | 0% | 2 |
| 1M | source10 | 50 | 0.614 | 29.4 | 59.5 | 84.2 | 0% | 0% | 0% | 2.03 |
| 1M | source50 | 10 | 0.969 | 12.1 | 22.9 | 86.1 | 0% | 0% | 55% | 1.45 |
| 1M | source50 | 50 | 0.961 | 38.8 | 88.7 | 119.1 | 0% | 0% | 18% | 2.27 |
| 1M | vis50 | 10 | 0.966 | 14.1 | 20.3 | 29.1 | 0% | 0% | 53% | 1.47 |
| 1M | vis50 | 50 | 0.958 | 33.5 | 81 | 91.7 | 0% | 0% | 25% | 2.19 |
| 1M | vis10 | 10 | 0.929 | 21.3 | 44.5 | 77.8 | 0% | 0% | 0% | 2 |
| 1M | vis10 | 50 | 0.626 | 35.1 | 86.9 | 148.8 | 0% | 0% | 0% | 2.05 |
| 2M | none | 10 | 0.965 | 9.1 | 17.4 | 25.4 | 0% | 0% | 100% | 1 |
| 2M | none | 50 | 0.977 | 16.7 | 20.3 | 24.4 | 0% | 0% | 100% | 1 |
| 2M | source10 | 10 | 0.950 | 21 | 26 | 29.8 | 0% | 0% | 0% | 2 |
| 2M | source10 | 50 | 0.558 | 32.8 | 46 | 104.1 | 0% | 0% | 0% | 2.03 |
| 2M | source50 | 10 | 0.975 | 14.5 | 19.3 | 23.2 | 0% | 0% | 39% | 1.61 |
| 2M | source50 | 50 | 0.977 | 26.9 | 87.2 | 119 | 0% | 0% | 39% | 1.72 |
| 2M | vis50 | 10 | 0.978 | 17.2 | 28.4 | 33.5 | 0% | 0% | 39% | 1.61 |
| 2M | vis50 | 50 | 0.979 | 31.9 | 92.2 | 121.9 | 0% | 0% | 39% | 1.76 |
| 2M | vis10 | 10 | 0.950 | 23.4 | 31.3 | 35 | 0% | 0% | 0% | 2 |
| 2M | vis10 | 50 | 0.565 | 37.6 | 108.3 | 187.1 | 0% | 0% | 0% | 2.05 |

Latency stays well inside budget once statistics exist: p95 is under 60 ms unfiltered and under 110 ms
filtered at 2M. The k=50 filtered p95 tail (90 to 310 ms) comes from searches whose index walk was
rejected and whose pooled statement re-ran.

### C. `relaxed_order` against `strict_order`

At the shipped `ef_search`, strict order is never better. It costs up to 0.11 recall@10 on 10% filters
at 250k and 1M (for example source10 k=10: 0.889 relaxed against 0.780 strict at 250k, 0.916 against
0.859 at 1M). At 2M the two are within 0.03, and at k=50 under a 10% filter both modes sit at 0.58 to 0.79.
The #6132 default stands.

### D. The cause: the first pool attempt's `max_scan_tuples`

Shipped `ef_search`, relaxed_order. Each size is a separate load. The 250k rows ran on the 4-vCPU Capy
machine, so compare their recall, not their latency.

| chunks | filter | k | max_scan_tuples | recall@k | recall@10 in call | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|
| 250k | source10 | 10 | shipped (2,000) | 0.899 | 0.899 | - | - |
| 250k | source10 | 10 | 8,000 | 0.994 | 0.994 | - | - |
| 250k | source10 | 50 | shipped | 0.794 | 0.953 | - | - |
| 250k | source10 | 50 | 8,000 | 0.982 | 0.997 | - | - |
| 250k | vis10 | 50 | shipped | 0.794 | 0.938 | - | - |
| 250k | vis10 | 50 | 20,000 | 0.985 | 0.997 | - | - |
| 1M | source10 | 10 | shipped | 0.898 | 0.898 | 19.2 | 26.1 |
| 1M | source10 | 10 | 20,000 | 0.982 | 0.982 | 25.7 | 41.4 |
| 1M | source10 | 50 | shipped | 0.594 | 0.918 | 29.7 | 51.6 |
| 1M | source10 | 50 | 8,000 | 0.913 | 0.990 | 38.7 | 46.9 |
| 1M | source10 | 50 | 20,000 | 0.987 | 0.994 | 48.0 | 57.9 |
| 1M | vis10 | 50 | shipped | 0.620 | 0.926 | 32.5 | 83.4 |
| 1M | vis10 | 50 | 20,000 | 0.985 | 0.997 | 49.2 | 57.0 |
| 2M | source10 | 10 | shipped | 0.927 | 0.927 | 23.2 | 28.8 |
| 2M | source10 | 10 | 20,000 | 0.988 | 0.988 | 29.5 | 51.7 |
| 2M | source10 | 50 | shipped | 0.572 | 0.963 | 35.8 | 44.9 |
| 2M | source10 | 50 | 8,000 | 0.835 | 0.989 | 48.1 | 60.4 |
| 2M | source10 | 50 | 20,000 | 0.958 | 0.992 | 68.9 | 93.1 |
| 2M | vis10 | 50 | shipped | 0.544 | 0.964 | 41.3 | 47.5 |
| 2M | vis10 | 50 | 20,000 | 0.959 | 0.992 | 69.4 | 91.1 |
| 1M, 2M | none | 10, 50 | 8,000 or 20,000 | unchanged | unchanged | ±1 ms | ±4 ms |

Why: a filtered search's index walk orders the whole index, so under a 10% filter it comes back short
and is rejected. The first pooled attempt then asks for 250 eligible chunks while visiting at most 2,000
tuples, which is about 200 eligible chunks at 10%. Because those chunks already cover 50 pages, the
attempt is accepted (mean attempts 2.0 to 2.05 at 1M and 2M in table B: the rejected walk plus one accepted pool attempt). But at 10% selectivity
and about 7 chunks per page, the 50th-best eligible page sits roughly 3,500 chunks deep, past the
visit budget. Recall@10 survives because the top ten pages
lie inside the visited set. `ef_search` sizes only the first candidate list, so raising it barely moves
recall@50 at 1M and 2M. The EXPLAIN below shows that pooled attempt: 2,242 index tuples visited, 250
candidates kept.

### E. Harder geometry (1M, rank 32, noise ×2)

The conclusion holds. Unfiltered recall@10 is 0.988. 10%-filtered recall@10 is 0.894 (source) and
0.905 (visibility), and recall@50 is 0.588 and 0.581. `ef_search` 1000 gives 0.963 and 0.964 at k=10
and 0.739 and 0.725 at k=50.

## Statistics states and EXPLAIN

The pgvector plan-flip lesson says to EXPLAIN at target size and across statistics states, and the
bench does. Each corpus is measured in three states, and the bench writes EXPLAIN (ANALYZE, BUFFERS,
SETTINGS) of the index walk, the first pooled attempt and a ×4 escalation to `explain/` for every
state, filter, k and `random_page_cost` (1.1 and 4).

- **fresh:** right after the load and index build. Autovacuum is off, nothing is ANALYZEd,
  `pages.reltuples` is 0 from the empty-table init, and `content_chunks` has no column statistics.
- **analyze:** after a plain `ANALYZE`.
- **vacuum:** after `VACUUM ANALYZE` plus `refreshProjectionStatistics`; the main grid runs here.
- **projection:** only the narrow `ANALYZE pages(text_projection_revision, knowledge_revision)` that
  import and sync run. Measured at 250k on the 4-vCPU machine.

Shipped settings:

| chunks | state | filter | k | recall@k | p50 ms | p95 ms | incomplete | walk served |
|---|---|---|---|---|---|---|---|---|
| 250k | fresh | none | 50 | 0.999 | 6,083 | 6,182 | 0% | 44% |
| 250k | fresh | source50 | 50 | 0.988 | 1,691 | 3,372 | 0% | 42% |
| 250k | projection | none | 50 | 0.429 | 8,078 | 8,105 | 57% | 43% |
| 250k | projection | vis50 | 50 | 0.321 | 8,079 | 8,112 | 67% | 33% |
| 250k | analyze | source10 | 50 | 0.802 | 29.5 | 262.8 | 0% | 0% |
| 1M | fresh | source10 | 10 | 1.000 | 3,393 | 3,413 | 0% | 0% |
| 1M | fresh | source50 | 50 | 0.937 | 10,003 | 10,004 | 54% | 0% |
| 1M | fresh | vis50 | 50 | 0.957 | 6,365 | 8,018 | 44% | 28% |
| 1M | analyze | source10 | 50 | 0.608 | 30.1 | 35.4 | 0% | 0% |
| 2M | fresh | none | 50 | 0.988 | 29.0 | 33.7 | 0% | 100% |
| 2M | fresh | source10 | 10 | 1.000 | 4,921 | 4,999 | 0% | 0% |
| 2M | fresh | source50 | 10 | 0.000 | 10,002 | 10,003 | 100% | 0% |
| 2M | fresh | source50 | 50 | 0.000 | 10,002 | 10,003 | 100% | 0% |
| 2M | fresh | vis50 | 50 | 0.396 | 8,016 | 8,020 | 60% | 40% |
| 2M | analyze | source10 | 50 | 0.538 | 36.4 | 48.4 | 0% | 0% |
| 2M | analyze | vis50 | 50 | 0.989 | 33.6 | 108.6 | 0% | 40% |

Without statistics the pooled statement sorts every eligible chunk by distance instead of walking the
index. A selective filter makes that exact and slow (3 to 5 s at 10%). A broad one runs past the 8 s
budget: searches end at about 10 s with zero vector rows and the arm reports incomplete. After ANALYZE
the plans return to HNSW and table A applies. No plan in any state used JIT, and
`random_page_cost` 1.1 against 4 changed a plan in only 3 of 504 EXPLAINs (250k m=32 builds, ×4
escalation, unfiltered).

EXPLAIN ANALYZE timings at random_page_cost 1.1, k=50 ("no: sort" = `Sort Key: (cc.embedding <=> $q)`
over the filtered join instead of the HNSW index):

| chunks | state | filter | index walk ms (HNSW?) | pool ms (HNSW?) | pool ×4 ms (HNSW?) |
|---|---|---|---|---|---|
| 250k | fresh | none | 19 (yes) | 3,065 (no: sort) | 3,127 (no: sort) |
| 250k | vacuum | none | 10 (yes) | 5 (yes) | 24 (yes) |
| 250k | vacuum | source10 | 7 (yes) | 10 (yes) | 237 (no: sort) |
| 1M | fresh | none | 17 (yes) | > 8,000 (no: sort) | > 8,000 (no: sort) |
| 1M | fresh | vis50 | 10 (yes) | 6,405 (no: sort) | 6,434 (no: sort) |
| 1M | vacuum | source10 | 8 (yes) | 14 (yes) | 52 (yes) |
| 2M | fresh | none | 61 (yes) | > 8,000 (no: sort) | > 8,000 (no: sort) |
| 2M | fresh | source10 | > 8,000 (yes, then a pages-first nested loop) | 2,944 (no: sort) | 2,960 (no: sort) |
| 2M | fresh | vis50 | 11 (yes) | > 8,000 (no: sort) | > 8,000 (no: sort) |
| 2M | vacuum | none | 16 (yes) | 7 (yes) | 38 (yes) |
| 2M | vacuum | source10 | 8 (yes) | 17 (yes) | 77 (yes) |
| 2M | vacuum | vis50 | 12 (yes) | 10 (yes) | 58 (yes) |

2M, fresh, 10% source filter, first pooled attempt. The planner estimates one page row, nested-loops
28,698 pages into their chunks and sorts 204,136 rows (vector literal shortened to `$q`, source-boost
CASE omitted):

```
Sort  (actual time=2915.766..2915.770 rows=10 loops=1)
  CTE hnsw_candidates
    ->  Limit  (actual time=2915.361..2915.382 rows=100 loops=1)
          ->  Sort  (cost=10965.47..10965.47 rows=1 width=358) (actual time=2915.361..2915.375 rows=100 loops=1)
                Sort Key: ((cc.embedding <=> $q))
                Sort Method: top-N heapsort  Memory: 310kB
                ->  Nested Loop  (cost=99.92..10965.46 rows=1 width=358) (actual time=0.082..2838.124 rows=204136 loops=1)
                      ->  Nested Loop  (cost=0.29..3.54 rows=1 width=204) (actual time=0.024..29.678 rows=28698 loops=1)
                            ->  Seq Scan on sources s  (rows=4)
                            ->  Index Scan using pages_dedup_idx on pages p  (cost=0.29..2.52 rows=1 width=204) (actual ... rows=7174 loops=4)
                                  Index Cond: ((source_id = s.id) AND (source_id = ANY ('{bench-a}'::text[])))
                      ->  Bitmap Heap Scan on content_chunks cc  (actual time=0.003..0.007 rows=7 loops=28698)
                            Recheck Cond: (p.id = page_id)
                            ->  Bitmap Index Scan on idx_chunks_page  (rows=7 loops=28698)
Settings: jit = 'off'
```

2M, VACUUM ANALYZEd, same filter, k=50, first pooled attempt. The HNSW iterative scan visits 2,242
tuples, keeps 250 candidates and is accepted:

```
Sort  (cost=7894.89..7895.02 rows=50 width=357) (actual time=16.885..16.890 rows=50 loops=1)
  CTE hnsw_candidates
    ->  Limit  (cost=3999.07..7865.66 rows=250 width=1309) (actual time=1.314..15.782 rows=250 loops=1)
          ->  Nested Loop  (actual time=1.314..15.747 rows=250 loops=1)
                ->  Nested Loop  (actual time=1.280..12.093 rows=250 loops=1)
                      ->  Index Scan using idx_chunks_embedding on content_chunks cc  (cost=3998.63..2641530.52 rows=2000063 width=1155) (actual time=1.247..9.120 rows=2242 loops=1)
                            Order By: (embedding <=> $q::vector)
                            Filter: ((embedding IS NOT NULL) AND (modality = 'text'::text) AND (model = 'bench:latent'::text))
                      ->  Memoize  (actual time=0.001..0.001 rows=0 loops=2242)
                            ->  Index Scan using pages_pkey on pages p  (actual time=0.003..0.003 rows=0 loops=658)
                                  Index Cond: (id = cc.page_id)
                                  Filter: ((deleted_at IS NULL) AND (source_id = ANY ('{bench-a}'::text[])) AND ...)
```

2M, VACUUM ANALYZEd, unfiltered k=50 index walk: `ann` is an HNSW scan of 500 rows in 5.7 ms, then joined by key; 15.6 ms in total.

## E5.4.2 results: index build options (measurement only)

Shipped search settings, VACUUM ANALYZEd, 100 queries. Builds use `CREATE INDEX CONCURRENTLY ... WITH (m, ef_construction)`, with maintenance_work_mem 4 GB, 12 GB or 20 GB by size and 8 parallel workers, unless the row says otherwise. Index size depends only on the type, because pgvector stores one element per page at 1,024 dimensions. Recall moves by up to ±0.02 between builds with the same options (each build is a new graph), so differences smaller than that are noise.

| chunks | index | build s | size GiB | none @10 | none @50 | source10 @10 | source10 @50 | source10 @10 in k=50 | none k=50 p50 ms |
|---|---|---|---|---|---|---|---|---|---|
| 250k | vector:16:64 (default) | 24.1 | 1.91 | 0.974 | 0.995 | 0.886 | 0.798 | 0.934 | 49 |
| 250k | vector:16:128 | 31.6 | 1.91 | 0.996 | 0.998 | 0.948 | 0.866 | 0.970 | 51.7 |
| 250k | vector:16:200 | 37.2 | 1.91 | 0.981 | 1.000 | 0.934 | 0.868 | 0.966 | 51.9 |
| 250k | vector:24:64 | 27.6 | 1.91 | 0.983 | 0.987 | 0.873 | 0.835 | 0.939 | 52.2 |
| 250k | vector:24:128 | 33.6 | 1.91 | 0.980 | 0.980 | 0.916 | 0.853 | 0.948 | 53.1 |
| 250k | vector:24:200 | 42.9 | 1.91 | 1.000 | 0.999 | 0.965 | 0.912 | 0.991 | 53.5 |
| 250k | vector:32:64 | 30.2 | 1.91 | 0.986 | 0.987 | 0.893 | 0.880 | 0.957 | 55.1 |
| 250k | vector:32:128 | 42 | 1.91 | 0.998 | 1.000 | 0.946 | 0.926 | 0.985 | 54.2 |
| 250k | vector:32:200 | 49.3 | 1.91 | 1.000 | 1.000 | 0.969 | 0.929 | 0.991 | 54.5 |
| 250k | vector:16:64:mwm=256MB:par=2 | 103.3 | 1.91 | 0.995 | 0.996 | 0.934 | 0.838 | 0.967 | 51.1 |
| 250k | halfvec:16:64 | 17.9 | 0.64 | 0.974 | 0.997 | 0.901 | 0.781 | 0.943 | 45.5 |
| 250k | halfvec:16:128 | 22.2 | 0.64 | 0.957 | 0.999 | 0.900 | 0.812 | 0.940 | 48.8 |
| 250k | halfvec:16:200 | 28 | 0.64 | 0.960 | 1.000 | 0.918 | 0.856 | 0.965 | 48.6 |
| 250k | halfvec:24:64 | 20.8 | 0.64 | 0.988 | 0.997 | 0.894 | 0.854 | 0.966 | 50.3 |
| 250k | halfvec:24:128 | 25.9 | 0.64 | 0.999 | 0.999 | 0.945 | 0.891 | 0.983 | 50.2 |
| 250k | halfvec:24:200 | 34.3 | 0.64 | 1.000 | 1.000 | 0.953 | 0.895 | 0.987 | 50.8 |
| 250k | halfvec:32:64 | 23.9 | 0.64 | 0.983 | 0.988 | 0.886 | 0.845 | 0.945 | 51.8 |
| 250k | halfvec:32:128 | 33.9 | 0.64 | 0.980 | 0.990 | 0.934 | 0.881 | 0.968 | 51.9 |
| 250k | halfvec:32:200 | 40.6 | 0.64 | 1.000 | 1.000 | 0.967 | 0.922 | 0.994 | 52.3 |
| 1M | vector:16:64 (default) | 103.4 | 7.63 | 0.963 | 0.992 | 0.912 | 0.614 | 0.939 | 15 |
| 1M | vector:16:128 | 129.6 | 7.63 | 0.997 | 0.997 | 0.942 | 0.678 | 0.960 | 16.1 |
| 1M | vector:16:200 | 142.9 | 7.63 | 0.967 | 0.998 | 0.928 | 0.717 | 0.945 | 16.9 |
| 1M | vector:24:64 | 112.5 | 7.63 | 0.944 | 0.981 | 0.873 | 0.592 | 0.903 | 18.6 |
| 1M | vector:32:64 | 125.3 | 7.63 | 0.983 | 0.994 | 0.889 | 0.601 | 0.922 | 17.6 |
| 1M | vector:32:200 | 201.1 | 7.63 | 0.998 | 0.999 | 0.948 | 0.750 | 0.976 | 17 |
| 1M | halfvec:16:64 | 71.8 | 2.54 | 0.984 | 0.992 | 0.920 | 0.592 | 0.938 | 14.4 |
| 1M | halfvec:32:200 | 168.8 | 2.54 | 0.985 | 0.998 | 0.942 | 0.730 | 0.970 | 15.5 |
| 2M | vector:16:64 (default) | 235.3 | 15.26 | 0.965 | 0.977 | 0.950 | 0.558 | 0.954 | 16.7 |
| 2M | vector:16:128 | 284.2 | 15.26 | 0.981 | 0.996 | 0.965 | 0.590 | 0.977 | 26.4 |
| 2M | halfvec:16:64 | 160.7 | 5.09 | 0.953 | 0.977 | 0.946 | 0.558 | 0.947 | 19.5 |

What the table shows:
- **`ef_construction` 128 or 200** raises unfiltered recall@10 to 0.98 to 1.0 in 9 of 10 builds (the
  exception is 1M m16/efc200 at 0.967), for 25 to 95% more build time. It lifts 10%-filtered recall@50 by 0.03 to 0.14 but leaves it at 0.59 to
  0.93, and it does not move the max_scan_tuples ceiling.
- **`m` 24 or 32 at `ef_construction` 64** shows no consistent gain. At 1M its filtered recall@10 is
  lower (0.873 and 0.889, against 0.912).
- **`halfvec`** matches `vector` recall within noise, builds about 1.4x faster (1.35x at 250k, 1.44x at
  1M, 1.46x at 2M), and is a third of the size. At 1.28M chunks that is about 3.3 GiB of index instead of about 9.8 GiB, which
  decides whether the index stays in memory on a smaller host. Adopting it needs a column migration:
  `ALTER TABLE ... TYPE halfvec(1024)` took 273 s at 2M.
- **Production-like build memory**: maintenance_work_mem 256 MB with 2 workers gave the same graph
  quality, but the build took 4.3x longer (103 s against 24 s at 250k) after pgvector spilled.

## Limitations

- **Real-vector coverage is one corpus.** The 1M real corpus is English Wikipedia: 207,185 articles, 4.8
  chunks each, about 920 characters per chunk, LID median 20.7 [14.1, 35.9], query top-1 cosine 0.70.
  Queries are the first sentence of random chunks, embedded as voyage-4 queries. A personal brain's mail,
  notes and transcripts may be more or less clustered. The truth was checked against gbrain's own
  `exactSql` for 15 queries: the top-10 and top-50 sets matched every time, and the order differed once
  below rank 50 (float near-ties).
- **The synthetic geometry is generated, not voyage-4 output.** Its local intrinsic dimension (median 15
  to 17) is a little below the real corpus (20.7). It reproduced the random-scope failure and the fix,
  but it cannot show the topic-coherent case. That case needs scopes that line up with clusters.
- **Truth and recall are page-level after max-pooling.** That matches what search returns. 100 queries
  give a standard error of about ±0.01 to 0.02 on recall@10.
- **Latency is server-local and single-client, with the index cached** (15 GiB index, 64 GB RAM).
  Production adds network round trips (about 7 per attempt), and a host that can't cache the index pays
  disk reads.
- **One build per cell.** HNSW graph variance between builds is about ±0.02, and up to 0.03 at 2M. The
  fix comparisons share one build per corpus, so their differences don't carry that variance.
- **Some rows ran on a 4-vCPU Capy machine** with a 128 MB shared_buffers container: the pre-fix
  `projection` row and the 250k max_scan_tuples rows. Their plan shapes and recall are comparable; their
  latencies are not.

## Reproduce

```bash
# VM (Ubicloud standard-16, 320 GB): bootstrap Docker, Bun 1.4.2 and a tuned pgvector/pg16 on 127.0.0.1:5434
UBI_OWNER=<thread> scripts/ubicloud/ubi-runner.sh up -s standard-16 -S 320
scripts/ubicloud/ubi-runner.sh sync <vm> . && scripts/ubicloud/ubi-runner.sh ssh <vm> 'cd work/gbrain && bash scripts/bench/hnsw-scale-vm-setup.sh'
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5434/postgres
B=scripts/bench/hnsw-iterative-scan.ts

# main grid + stats states + EXPLAIN + E5.4.2 builds (250k shown; 1M used --build-mwm 12GB, 2M 20GB)
bun $B --corpus latent --chunks 250000 --queries 100 --workers 14 --explain --build-mwm 4GB --build-parallel 8 \
  --builds vector:16:128,vector:16:200,vector:24:64,vector:24:128,vector:24:200,vector:32:64,vector:32:128,vector:32:200,vector:16:64:mwm=256MB:par=2,halfvec:16:64,halfvec:16:128,halfvec:16:200,halfvec:24:64,halfvec:24:128,halfvec:24:200,halfvec:32:64,halfvec:32:128,halfvec:32:200
bun $B --corpus latent --chunks 1000000 --queries 100 --workers 14 --explain --build-mwm 12GB --build-parallel 8 \
  --builds vector:16:128,vector:16:200,vector:24:64,vector:32:64,vector:32:200,halfvec:16:64,halfvec:32:200
bun $B --corpus latent --chunks 2000000 --queries 100 --workers 14 --explain --build-mwm 20GB --build-parallel 8 --builds vector:16:128,halfvec:16:64

# ef_search 800/1000 and strict_order (2M used --queries 50)
bun $B --corpus latent --chunks <n> --queries 100 --workers 14 --states '' --verify 0 --ef shipped,400,800,1000 --modes relaxed_order,strict_order
# max_scan_tuples pin
bun $B --corpus latent --chunks <n> --queries 100 --workers 14 --states '' --verify 0 --filters none,source10,vis10 --ef shipped --max-scan-tuples shipped,8000,20000
# harder geometry
bun $B --corpus latent --chunks 1000000 --queries 100 --workers 14 --states '' --seed 6133 --latent-rank 32 --latent-noise 0.3 --ef shipped,400,1000 --filters none,source10,vis10
# fixes, same database: load with the fixed tree (--keep), then rerun a master checkout and the
# escalate-when-short variant against it with --db (each run's --out needs the load's truth.json)
bun $B --corpus latent --chunks 1000000 --queries 100 --workers 14 --states projection --explain --keep --build-mwm 12GB --build-parallel 8 --ef shipped,400 --out out/fixed-1000000
bun $B --corpus latent --chunks 1000000 --queries 100 --db <db from out/fixed-1000000/results.json> --ef shipped --verify 0 --out out/master-1000000
# real vectors: prepare 1M Wikipedia chunks, embed them with voyage-4 (capped by --max-usd, ledger.json beside the corpus)
python3 scripts/bench/hnsw-real-corpus-prep.py corpus --chunks 1000000
VOYAGE_API_KEY=... bun $B --corpus dir --corpus-dir corpus --chunks 1000000 --queries 100 --workers 14 --states '' --explain --keep \
  --build-mwm 12GB --build-parallel 8 --ef shipped,400,1000 --max-scan-tuples shipped,20000 --max-usd 28 --out out/real-master
bun $B --corpus dir --corpus-dir corpus --chunks 1000000 --queries 100 --db <db> --ef shipped --max-scan-tuples shipped,50000,100000 --verify 0 --out out/real-fixed
# pages-only (import/sync) statistics state
bun $B --corpus latent --chunks 250000 --queries 30 --states projection --verify 0 --filters none,source10,source50,vis50 --ef shipped --explain --no-grid
```

**Wall time.** Two standard-16 VMs ran 04:20 to 06:22 PT (VM A, 250k then 1M) and 04:20 to 06:05 PT
(VM B, 2M) on October 9, 2026, about 60 vCPU-hours in total, and both were destroyed after the run.

| run | load + truth | default build | full run |
|---|---|---|---|
| 250k main | 38 s | 24 s | 34 min (18 builds included) |
| 1M main | 153 s | 103 s | 62 min (30 min of it in the fresh-state pass) |
| 2M main | 223 s | 235 s | 70 min (36 min in the fresh-state pass) |
| sweeps (250k / 1M / 2M) | | | 6 / 8 / 11 min |
| max_scan_tuples (1M / 2M) | | | 5 / 9 min |
| fix comparison, synthetic (fixed / master / escalate) | 1M: 4 min | 1M: 2 min | 1M: 9 / 1 / 2 min; 2M: 17 / 1 / 2 min |
| real 1M (prep, voyage-4 embedding, load, grid) | prep 27 s, embedding 38 min | 2 min | 46 min master grid; fixed 3 min, escalate 5 min |

The fix runs used two more standard-16 VMs on October 9: about 07:05 to 07:45 PT for the synthetic
comparison, and about 06:55 to 08:00 PT for the real corpus. Both were destroyed after the runs. The real
corpus (chunks, vectors, queries and ledger) is kept outside the repository on the builder machine, so a rerun pays nothing for embeddings.

## Changelog

- 2026-10-09: noted that v0.60.134.0 counts scope chunks and raises the scan cap to 120,000, which moves
  the 104,000-chunk source onto the exact scan. The pooled budget still serves visibility scopes and larger sources.
- 2026-10-09: measured again on top of v0.60.131.0's exact scope scan: share buckets from 0.1% to 55%,
  visibility and type-filtered scopes, at 50k pages and 1M chunks, synthetic and real. The pooled budget
  stays because it adds recall wherever the pool runs. The scan cap for large topic-coherent sources is
  proposed.
- 2026-10-09: fix 1 (pooled attempts scan 20,000 tuples) and fix 2 (import, sync, reindex and embed
  drains refresh the content_chunks and search-filter page statistics) ship with the same-database
  comparisons above. The real-vector confirmation used 1M voyage-4 Wikipedia chunks ($13.07), and found
  that topic-coherent selective scopes remain a gap. `--corpus dir`, `--max-scan-tuples`, the `projection`
  stats state and `scripts/bench/hnsw-real-corpus-prep.py` were added to the bench.

- 2026-10-09: first scale measurement (E5.4.1, E5.4.2) at 250k, 1M and 2M synthetic-latent chunks.
  `scripts/bench/hnsw-iterative-scan.ts` gains `--corpus latent` (`scripts/bench/hnsw-latent-corpus.ts`),
  the ef_search, max_scan_tuples, filter, statistics-state and build grids, and EXPLAIN capture; the VM
  bootstrap is `scripts/bench/hnsw-scale-vm-setup.sh`.
