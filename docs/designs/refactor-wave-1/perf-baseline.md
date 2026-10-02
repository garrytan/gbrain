# Refactor wave 1: performance baseline (plan (f), EO14, T-G15)

Numbers captured on master code before any wave-1 move. The production tree
under test is `src/` tree `572d56d26285bc5b501f4ab1ec0d8370de58e1e6`, identical
to master `f8d1e3936` (v0.60.11.0). The bench commit was `ff3118aa9` on
`refactor/wave-1-w0a` (the bench script and design docs sit on top of master;
`git rev-parse HEAD:src` proves the code under test is master's). The bench
records `commit`, `src_tree` and `dirty` in every JSON report.

The bench is `scripts/bench-refactor-wave-1.ts`. It is a bench, not a test: no
CI lane runs it. `test/bench-refactor-wave-1.test.ts` covers its pure helpers
and brings it under `bun run typecheck` (tsconfig includes only `src/` and
`test/`).

## What is measured and how

| Metric | Method |
|---|---|
| Import throughput | `importFromContent` (parse, chunk, embed through the gateway, `putPage` + `upsertChunks` in the import transaction) over the fixed corpus, 4 concurrent workers. Total pages/s plus per-page latency. Asserts every chunk got an embedding. |
| `getPage`, `searchKeyword`, `searchVector` (limit 20 and `MAX_SEARCH_LIMIT` = 100, `src/core/engine.ts`), `putPage` | Engine method called directly, concurrency 1, 20 warmup + 200 timed calls, inputs cycled from fixed lists. |
| `_upsertChunksOnce` | The private engine method, timed inside `engine.transaction()` exactly as `upsertChunks` calls it (transaction BEGIN/COMMIT excluded from both time and round trips). Alternates two 3-chunk variants so every call replaces rows. |
| `hybridSearchCached` warm | The `query` op entry point (`src/core/search/hybrid.ts`), default mode (balanced, reranker on), limit 20, 20 warmup + 50 timed calls over 20 fixed queries. |
| `hybridSearchCached` cold | Fresh `bun` process per sample: connect to the seeded brain, time the first call, then 5 more warm calls of the same query. 1 discarded + 10 samples. |
| SQL round trips | Separate count pass (latency passes never count). Postgres/PgBouncer: a second, instance-owned pool connects through a loopback TCP proxy that parses the frontend protocol; one round trip = one Sync (`S`) or simple Query (`Q`), and Parse (`P`) messages are counted separately (lost prepared statements show up as parses). PGLite: the raw PGlite instance's `execProtocolRawSync` is wrapped; one round trip = one protocol exchange with the WASM backend. 1 first call + 3 warmup + 10 counted calls per op. |
| Provider calls | Deterministic stub embedder and reranker installed through the gateway's `__setEmbedTransportForTests` / `__setRerankTransportForTests` seams, counting calls and embedded texts. `globalThis.fetch` is replaced by a guard that counts and fails any network attempt (must stay 0). |
| `gbrain --version` cold start | `bun --no-env-file src/cli.ts --version` and the compiled `bin/gbrain --version` (`bun run build`), process wall time, 1 discarded + N samples. |
| PGLite connect + initSchema cold start | Fresh process, in-memory PGLite, `connect({})` + `initSchema()`, snapshot ON (`GBRAIN_PGLITE_SNAPSHOT` = `test/fixtures/pglite-snapshot-default.tar`, built by `bun run build:pglite-snapshot --profile default`; the bench asserts `_snapshotLoaded === true`) and OFF (`GBRAIN_NO_SNAPSHOT=1`, full migration replay; asserts `false`). |
| Engine-connect cold start (non-compiled) | Fresh process mirroring the CLI connect path: gateway configured, `import('src/core/engine-factory.ts')`, `createEngine` + `connect`, then `import('src/core/migrate.ts')` + `tryRunPendingMigrations` (the pending-migration probe that loads the registry). Process wall time plus in-process phases. PGLite connects to the seeded file-backed brain; Postgres to the seeded bench database. |

Semantic result cache: CLAUDE.md says semantic result reuse is disabled. The
switch is `semanticResultCacheAvailable()` in `src/core/search/query-cache.ts`,
which returns `false`, so `hybridSearchCached` builds no `SemanticQueryCache`
and reports `meta.cache.status = 'disabled'`. The bench fails unless, on every
backend and in every cold child: `semanticResultCacheAvailable() === false`,
every observed `hybridSearchCached` call reports `cache.status === 'disabled'`
(84 calls per in-process run), and `SELECT count(*) FROM query_cache` is 0 at
the end. All 18 full runs below (9 local, 9 VM) and the 6 count-only runs passed
these assertions.

Warmed caches, named (what "warm" means in the hybrid numbers):

| Cache | Where | Backends | Observed |
|---|---|---|---|
| ES module registry (dynamic `import()` of `search/mode.ts`, `ai/gateway.ts`, `query-cache.ts`, rerank, ...) | Bun runtime | all | cold first call 350-450 ms vs warm 75-125 ms |
| `PgliteStatementCache` (named statement from the 2nd sighting of a SQL text) | `src/core/pglite-statements.ts` | PGLite | 0 entries before the first call, 2 after; first call 110 round trips, warm 40 |
| postgres.js per-connection prepared statements (`prepare` true) | `vendor/postgres` | direct PG | parses per hybrid call 13-14 direct vs 21-27 on PgBouncer (prepare false) |
| postgres.js pool connections + array type fetch on first connection | `vendor/postgres` | direct PG, PgBouncer | first counted call 34 round trips vs 24-31 warm |
| `vectorIterativeScan` capability probe | `pglite-engine.ts` / `postgres-engine.ts` | all | unset before the first call, set after |
| Supersede-edge probe (per-engine WeakMap, 5 min TTL) | `hasAnySupersedeEdges`, `src/core/search/hybrid.ts` | all | not observable without a src seam; covered by the cold/warm split |
| Query-embedding cache | none exists | - | every hybrid call makes exactly 1 embed call (embed_texts 1) and 1 rerank call |
| Semantic result cache (`query_cache`) | hard-disabled, asserted above | - | 0 rows, status `disabled` |

## Fixed sizes

| Knob | Value |
|---|---|
| Corpus | 400 synthetic pages (`bench/topic-NNNN`), 6 paragraphs x 80 words from a fixed 256-word seeded vocabulary, 2 chunks per page (800 chunks) |
| Import concurrency | 4 workers |
| Op concurrency | 1 (sequential) |
| Warmup / timed iterations | 20 / 200 per engine op; 20 / 50 for `hybridSearchCached` |
| Count pass | 1 first call + 3 warmup + 10 counted calls per op; 10 extra imported pages (`bench/extra-*`) for `importFromContent` |
| Cold-start samples | 1 discarded + 10 fresh processes per series (30 for the noise study below) |
| Embedding shape | `voyage:voyage-4`, 1024 dims (CLI default profile), stub vectors seeded by sha256 of the text |
| Pool | module singleton pool at `resolvePoolSize()` default; count pass uses an instance pool of the same size |
| Repetitions | 3 full runs per configuration, interleaved pglite -> postgres -> pgbouncer per round |

## Machines

| | Local (Capy machine) | VM (Ubicloud) |
|---|---|---|
| CPU | AMD EPYC, 4 vCPU (2 threads/core) | AMD EPYC 9454P, standard-16 (16 vCPU) |
| RAM | 15.6 GB | 62 GB |
| OS / kernel | Ubuntu 24.04, 6.1.158+ | Ubuntu 24.04, 6.8.0-106-generic |
| Bun | 1.3.14 | 1.3.13 (pinned by `setup-ci-vm.sh`) |
| Postgres | `pgvector/pgvector:pg16` (16.15) in Docker, default durability settings | `pgvector/pgvector:pg16` from `scripts/ubicloud/setup-ci-vm.sh` (`SLOTS=1`), `fsync=off synchronous_commit=off full_page_writes=off` |
| PgBouncer | `edoburu/pgbouncer:latest`, transaction mode, pool 10, same ignore list as CI | same image and settings, from `setup-ci-vm.sh` |

PgBouncer runs with `GBRAIN_PREPARE=false` set explicitly by the bench: pooler
ports here are not the 6543 auto-detect port. Direct Postgres keeps the
postgres.js default (`prepare` true).

## Exact commands

The local Postgres URLs below omit the password; export `PGPASSWORD` for the test container first.

```bash
bun install
bun run build                       # bin/gbrain for the compiled --version series

# PGLite (temp file-backed brain; snapshot and --version series included)
bun scripts/bench-refactor-wave-1.ts --backend pglite --binary bin/gbrain --json > pglite-1.json

# Direct Postgres (creates and drops gbrain_bench_test_<hex> on that server)
bun scripts/bench-refactor-wave-1.ts --backend postgres \
  --url postgresql://postgres@127.0.0.1:5434/postgres \
  --admin-url postgresql://postgres@127.0.0.1:5434/postgres --binary bin/gbrain --json > postgres-1.json

# PgBouncer (transaction mode) in front of the same server
bun scripts/bench-refactor-wave-1.ts --backend pgbouncer \
  --url postgresql://postgres@127.0.0.1:6434/postgres \
  --admin-url postgresql://postgres@127.0.0.1:5434/postgres --binary bin/gbrain --json > pgbouncer-1.json
```

Drop `--json` for the human table. Local ports above are the docker containers
from docs/TESTING.md's E2E lifecycle (`pg` on 5434, `pgb` on 6434). On the VM
the URLs were `127.0.0.1:15433/gbrain_test` (direct) and
`127.0.0.1:16433/gbrain_test` (PgBouncer). VM invocation (one standard-16 VM,
destroyed by the runner on exit; confirmed `destroyed eu-central-h1/ubirun-1790748024-838f4432`):

```bash
UBICLOUD_API_KEY=$UBICLOUD_API_TOKEN scripts/ubicloud/ubi-runner.sh run -s standard-16 \
  --setup scripts/ubicloud/setup-ci-vm.sh --env SLOTS=1 \
  --pull 'work/gbrain/bench-out:<local-dir>' -- '<bun run build; 3 rounds x {pglite, postgres, pgbouncer} as above>'
```

## Results

Each cell is the median of the three runs' medians, with the run-to-run range
(max - min of the three medians) as a percentage of that median. Milliseconds
unless stated. "VM" columns are the reference for Postgres and PgBouncer.

| metric | PGLite local | PGLite VM | Direct PG VM | PgBouncer VM | Direct PG local | PgBouncer local |
|---|---:|---:|---:|---:|---:|---:|
| import pages/s (c=4) | 25.9 (±2%) | 24.2 (±2%) | 47.2 (±26%) | 40.3 (±6%) | 69.0 (±0%) | 56.4 (±3%) |
| import per-page median ms | 159.4 (±2%) | 168.4 (±2%) | 81.4 (±21%) | 91.6 (±5%) | 54.0 (±2%) | 67.3 (±3%) |
| getPage median ms | 0.60 (±2%) | 0.93 (±1%) | 3.42 (±2%) | 1.48 (±26%) | 2.28 (±66%) | 2.22 (±13%) |
| getPage p95 ms | 0.67 (±5%) | 0.98 (±1%) | 5.18 (±8%) | 2.20 (±55%) | 3.97 (±21%) | 3.56 (±12%) |
| searchKeyword median ms | 8.76 (±2%) | 11.7 (±1%) | 16.7 (±4%) | 7.38 (±7%) | 9.29 (±63%) | 13.4 (±33%) |
| searchKeyword p95 ms | 11.8 (±6%) | 12.0 (±4%) | 18.9 (±9%) | 9.22 (±4%) | 16.6 (±11%) | 18.8 (±14%) |
| searchVector limit=20 median ms | 15.0 (±6%) | 19.0 (±1%) | 25.2 (±4%) | 14.1 (±20%) | 21.7 (±31%) | 23.1 (±12%) |
| searchVector limit=20 p95 ms | 18.4 (±38%) | 19.6 (±2%) | 28.6 (±7%) | 15.5 (±7%) | 24.9 (±1%) | 28.2 (±13%) |
| searchVector limit=100 (MAX_SEARCH_LIMIT) median ms | 19.0 (±6%) | 23.3 (±0%) | 33.6 (±1%) | 17.6 (±6%) | 21.8 (±12%) | 26.9 (±7%) |
| searchVector limit=100 p95 ms | 20.8 (±16%) | 23.7 (±2%) | 37.2 (±3%) | 22.1 (±8%) | 31.0 (±3%) | 34.3 (±9%) |
| putPage median ms | 1.83 (±4%) | 2.10 (±1%) | 5.78 (±6%) | 8.40 (±7%) | 3.33 (±54%) | 3.51 (±148%) |
| _upsertChunksOnce median ms | 11.4 (±5%) | 12.9 (±0%) | 20.6 (±21%) | 14.9 (±7%) | 14.9 (±21%) | 18.5 (±9%) |
| _upsertChunksOnce p95 ms | 43.4 (±3%) | 42.7 (±1%) | 36.5 (±10%) | 20.1 (±4%) | 26.8 (±1%) | 29.5 (±8%) |
| hybridSearchCached warm median ms | 74.9 (±8%) | 86.3 (±1%) | 121.9 (±6%) | 119.0 (±6%) | 108.9 (±9%) | 121.3 (±16%) |
| hybridSearchCached warm p95 ms | 110.7 (±5%) | 95.2 (±10%) | 151.0 (±22%) | 153.5 (±17%) | 131.5 (±4%) | 136.7 (±4%) |
| hybridSearchCached cold first call median ms | 359.4 (±6%) | 447.8 (±4%) | 386.7 (±7%) | 350.6 (±6%) | 362.2 (±7%) | 345.5 (±3%) |
| hybrid cold child process wall median ms | 1626.1 (±4%) | 1835.0 (±2%) | 1438.9 (±0%) | 1407.1 (±1%) | 1054.5 (±8%) | 1063.9 (±6%) |
| engine connect cold, process wall median ms | 568.2 (±8%) | 705.0 (±12%) | 246.8 (±12%) | 220.1 (±8%) | 227.3 (±5%) | 214.2 (±20%) |
| engine connect cold, in-process connect ms | 417.2 (±8%) | 465.4 (±5%) | 82.3 (±33%) | 48.8 (±8%) | 73.2 (±1%) | 60.9 (±28%) |
| PGLite connect+initSchema snapshot ON, wall ms | 879.5 (±3%) | 1006.4 (±2%) | n/a | n/a | n/a | n/a |
| PGLite connect+initSchema snapshot ON, in-process ms | 659.5 (±3%) | 701.3 (±1%) | n/a | n/a | n/a | n/a |
| PGLite connect+initSchema snapshot OFF, wall ms | 2999.9 (±2%) | 3137.9 (±2%) | n/a | n/a | n/a | n/a |
| PGLite connect+initSchema snapshot OFF, in-process ms | 2696.3 (±3%) | 2791.0 (±2%) | n/a | n/a | n/a | n/a |
| `bun src/cli.ts --version` wall median ms | 672.9 (±4%) | 714.7 (±0%) | 716.1 (±1%) | 716.5 (±0%) | 678.9 (±5%) | 675.7 (±1%) |
| `bin/gbrain --version` wall median ms | 706.1 (±1%) | 770.1 (±0%) | 769.2 (±1%) | 771.1 (±1%) | 725.0 (±7%) | 728.4 (±1%) |

The `--version` rows are backend-independent (each run measures them); the
spread across backend columns on one machine is itself a noise sample.

Cold-start noise study (local 4-core, PGLite, `--cold-runs 30`, 3 runs):

| series | run medians (ms) | range |
|---|---|---|
| engine connect, process wall | 577.3 / 587.5 / 612.7 | 35.4 ms (6.0%) |
| engine connect, in-process connect | 421.8 / 434.6 / 457.7 | 35.9 ms (8.3%) |
| snapshot ON, process wall | 884.5 / 886.1 / 890.8 | 6.3 ms (0.7%) |
| snapshot ON, in-process connect+init | 647.6 / 660.5 / 652.6 | 12.9 ms (2.0%) |
| snapshot OFF, process wall | 2995.7 / 2970.3 / 2983.3 | 25.4 ms (0.9%) |
| `bun src/cli.ts --version` | 666.8 / 667.3 / 673.0 | 6.2 ms (0.9%) |
| `bin/gbrain --version` | 708.9 / 701.3 / 708.5 | 7.5 ms (1.1%) |

### SQL round trips and provider calls per call

Steady state (10 counted calls after 3 warmup calls). These were identical in
all 3 full runs per backend, on both machines, and in two extra count-only runs
(`--phases import,count`) that also recorded the per-call vectors below.

| op | PGLite rt/call | PGLite parses/call | direct PG rt/call | direct PG parses/call | PgBouncer rt/call | PgBouncer parses/call | provider calls/call |
|---|---:|---:|---:|---:|---:|---:|---|
| getPage | 1 | 0 | 1 | 1 | 1 | 1 | none |
| searchKeyword | 1 | 0 | 4 | 1 | 4 | 3 | none |
| searchVector limit=20 | 28 | 4 | 7 | 4 | 7 | 6 | none |
| searchVector limit=100 | 28 | 4 | 7 | 4 | 7 | 6 | none |
| putPage | 10 | 0 | 7 | 4 | 7 | 6 | none |
| _upsertChunksOnce | 9 | 0 | 9 | 6 | 9 | 9 | none |
| hybridSearchCached | 40 (39 for 1 of 10 queries) | 4 | 31 (24 for 1 of 10 queries) | 13-14 | 31 (24) | 21-27 | 1 embed (1 text) + 1 rerank |
| importFromContent (per page) | 52 | 0 | 57 | 39 | 57 | 54 | 1 embed (2 texts) |

Per-call vectors over the fixed 10-call sequence (query indices 4..13):
`hybridSearchCached` PGLite `[40,40,40,40,40,39,40,40,40,40]` total 399;
direct PG and PgBouncer `[31,31,31,31,31,24,31,31,31,31]` total 303. Parse
totals over the 10 calls: PGLite hybrid 40, direct PG hybrid 139, PgBouncer
hybrid 264; direct PG import 390, PgBouncer import 540. Import of the 400-page
corpus makes exactly 400 embed calls (800 texts), 0 rerank, 0 fetch. Every run's
process total was 498 embed calls, 912 texts, 84 rerank calls, 0 fetch attempts.

First-call counts are informational (they depend on which pool connection is
hit and on prior warm-up): e.g. hybrid first call 34 on direct PG/PgBouncer,
110 in a fresh PGLite process (statement cache empty) vs 40 warm.

## Budgets (numeric; check after every domain commit)

Procedure: run master (or the pre-change commit) and the candidate on the SAME
machine in the same session, alternating A/B per round, 3 rounds per backend,
default sizes. Compare the median of the three run medians. The VM is the
reference machine for direct PG and PgBouncer; PGLite may use the local 4-core
machine (the EO14 cold-start budget names it) or the VM. If one latency metric
exceeds its band, run 3 more A/B rounds; it fails only if it exceeds again.

Hard equality (any difference fails, no rerun):

1. SQL round trips per call: the steady-state `per_call` vector and `total` of
   every op in the count pass, on PGLite, direct PG and PgBouncer.
2. Parses: PGLite and PgBouncer `parses_total` equal. Direct PG
   `parses_per_call_max` <= baseline + 1 (pool-connection assignment moves the
   first Parse of a statement between connections: 13-14 per hybrid call);
   losing `prepare` would move direct PG to the PgBouncer levels (hybrid 21-27,
   import 54), which this catches even when latency cannot.
3. Provider calls per call and import totals equal (embed calls, embedded texts,
   rerank calls); fetch attempts 0.
4. Semantic result cache assertions pass (the bench throws otherwise).

Latency bands (median of three run medians, candidate vs baseline):

| metric | PGLite | direct PG, PgBouncer | noise the band is based on |
|---|---|---|---|
| getPage, searchKeyword, searchVector (20 and 100), putPage, _upsertChunksOnce, hybridSearchCached warm | <= max(baseline x 1.10, baseline + 0.5 ms) | <= max(baseline x 1.25, baseline + 2 ms) | PGLite range <= 8% local, <= 1.3% VM; VM PG/PgBouncer range <= 26% (getPage PgBouncer 0.39 ms, _upsertChunksOnce direct 21%) |
| import pages/s | >= baseline x 0.90 | >= baseline x 0.75 | PGLite 2%; VM direct 26%, PgBouncer 6% |
| hybridSearchCached cold first call | <= max(baseline x 1.10, baseline + 25 ms) | same | range 3-7% (<= 27 ms) |
| PGLite connect + initSchema, snapshot ON (in-process and wall) | <= baseline + 20 ms (EO14) | n/a | 30-sample range 6-13 ms |
| PGLite connect + initSchema, snapshot OFF | <= max(baseline x 1.05, baseline + 50 ms) | n/a | range 1-3% (25-73 ms) |
| `gbrain --version` (source and compiled) | <= baseline + 20 ms (plan (f)) | same | 30-sample range 6-8 ms; VM 2-5 ms |
| engine connect cold (non-compiled, process wall) | <= baseline + 20 ms (EO14) | <= baseline + 20 ms | see note |

p95 and max are recorded for diagnosis and not gated; flag a p95 above
baseline x 1.5 for a look.

Note on the engine-connect budget: at 10 samples the run-to-run range is
12-85 ms, and at 30 samples the file-backed PGLite connect still drifted 35 ms
across three runs (577 -> 588 -> 613 ms, monotonic, i.e. machine drift). The
+20 ms budget is therefore judged on the paired A/B difference: use
`--cold-runs 30 --phases import,connect,snapshot,version`, alternate A/B for 3
rounds, and require the median of the three per-round differences
(candidate - baseline) <= 20 ms. The snapshot-ON path and `--version` resolve
+20 ms directly (ranges <= 13 ms).

## Observations (not investigated further)

- On the VM, direct Postgres is slower than PgBouncer for `getPage`,
  `searchKeyword` and `searchVector` (e.g. searchKeyword 16.7 vs 7.4 ms) with
  identical round-trip counts; the local docker pair shows no such gap. The
  bench only records it; the budget compares each backend with itself.
- `bin/gbrain --version` is 30-55 ms slower than `bun src/cli.ts --version` on
  both machines.
- PGLite `searchVector` takes 28 protocol exchanges per call: statements run
  through `query(sql, params, options)` bypass `PgliteStatementCache` (unnamed
  Parse/Describe/Sync each time), while `getPage` and `searchKeyword` are served
  by the cache in one exchange.

## Limitations

- `gbrain doctor --fast` cold start (CEO section 7) is not measured; the
  engine-connect series covers the connect + migrate-probe path it shares.
- Supersede-probe and private-visibility caches are not observable without a
  src seam, so they are named but not probed.
- Round trips are counted on a second pool through a proxy, not on the
  latency pool; the count pass is sequential, so pool size does not change the
  totals.
- VM Postgres runs with CI's `fsync=off` settings; write latencies there are
  optimistic compared with a durable server, identically for baseline and
  candidate.
