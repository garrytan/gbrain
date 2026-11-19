# gbrain baseline: PGLite and Postgres through the real engines

This is the TypeScript half of the Rust store bake-off. It runs the shared workload (`gbrain-bakeoff-result/1`, see the
bake-off spec) against gbrain's current engines, so the Rust candidates in `rust/bench` have honest numbers to beat.
It calls the same code gbrain does: `createEngine` + `connect` + `initSchema`, `putPage`, `upsertChunks`,
`sealPageTextProjection`, `getPage`, `listPages`, `getChunks`, `searchVector`.

It never calls an embedding or chat provider. Every vector comes from the corpus, the embedding column is gbrain's
default `vector(1024)`, and provider-looking environment variables (anything with KEY, TOKEN, SECRET, PASSWORD, or a
provider name) are removed from the runner and from every child process it starts.

## Run it

```bash
export PATH=/var/tmp/bun144/bun-home/bin:$HOME/.cargo/bin:$PATH     # Bun 1.4.4 on this machine

# PGLite (data dir and GBRAIN_HOME live under --scratch, default /var/tmp/gbrain-bakeoff; nothing touches ~/.gbrain)
bun rust/bench/baseline/run.ts --engine pglite --corpus /var/tmp/w1/corpus-10k --scale 10k \
    --out /var/tmp/w1/results/pglite-10k.json --fresh

# Postgres (TCP URL: postgres.js reads ?host=/dir as a server setting and fails, so the socket form does not work)
bun rust/bench/baseline/run.ts --engine postgres --corpus /var/tmp/w1/corpus-10k --scale 10k \
    --out /var/tmp/w1/results/postgres-10k.json \
    --database-url postgresql://postgres@127.0.0.1:55432/bakeoff_10k --create-db --fresh

# 200k (the same commands with --corpus /var/tmp/w1/corpus-200k --scale 200k; see "Time and the PGLite ceiling")
# Smoke test: 500 pages, short windows, about 40 s
bun rust/bench/baseline/run.ts --engine pglite --corpus /var/tmp/w1/corpus-10k --scale 10k --out out.json --quick
```

Flags (run with `--help` for the full list): `--only a,b,c` runs named metrics against an existing store; `--hnsw
inline|deferred|skip`; `--import-workers N`; `--pool-max N` (Postgres, default 20); `--max-seconds N` (cap for each
single-client metric, default 120; the actual `n` is in the result); `--limit-pages N`; `--quick`.

A default run needs an empty store. `--fresh` deletes only a store this runner created: a PGLite directory with a
`<dir>.bakeoff-marker` file, or a Postgres database whose comment is `gbrain-bakeoff-baseline`. It refuses anything else.
The corpus directory is read only, except that the exact ground truth is cached in `<corpus>/truth_top10.json`
(the format the Rust harness also reads and writes: per query, the 10 nearest chunk row numbers, plus a
fingerprint: the byte size and sha256 of `vectors.f32` and `queries.f32`, the dims and k). A cached file is reused
only when the fingerprint of the current corpus files matches; a different corpus in the same directory, or a file
with no fingerprint, makes the runner recompute the truth and rewrite the file. Rebuilding a corpus with
`rust/scripts/export-corpus.ts --overwrite` or `rust/bench/corpus/dbpedia.py` deletes the old file.

Type check: `cd <repo> && node_modules/.bin/tsc --noEmit -p rust/bench/baseline/tsconfig.json`. The root tsconfig does
not include `rust/`, and this project config pulls in `src/` files that need ambient declarations the root build
supplies, so look only at errors under `rust/`.

## What each metric measures

Metrics run in this order. The vector metrics run before any write, so the duplicate corpus vectors the write
metrics add cannot distort recall.

| Metric | What it does |
| --- | --- |
| `import` | Per page, one `engine.transaction`: `putPage`, `upsertChunks` (embeddings plus chunker-version seal), `sealPageTextProjection`, the same sequence `importFromContent` runs. Markdown parsing, chunking, embedding and link/tag projection are not run, so this is store work only. Then `ANALYZE`. Fields: `seconds`, `chunks_per_s`, `analyze_seconds`, `hnsw_build_seconds`, `total_seconds`, `chunks_per_s_total`. |
| `cold_open` | A fresh process runs `createEngine` + `connect` + first `getPage`. Median of 3. The OS file cache is warm and the Postgres server is already up. For PGLite the parent lets go of the data dir first. |
| `get_page` | 20k random `getPage(slug, {sourceId})`, one client. |
| `read_c1/c4/c16` | 1/4/16 async clients looping `getPage` for 5 s. |
| `list_pages` | `listPages({sourceId:'default', sort:'slug', limit:100, slugAfter})` from a random slug in the first 80%. |
| `get_chunks` | `getChunks(slug, {includeEmbedding:true})` of a random page (4 chunks). |
| `vector_exact` | The engine's own SQL shape with `enable_indexscan` and `enable_bitmapscan` off, 200 queries. `recall_at_10` is a sanity check against the truth (about 1). |
| `vector_ann` | 200 `searchVector(q, {limit:10})`. `recall_at_10` is chunk-level against the exact truth, `recall_at_10_page` compares distinct pages. `searchVector` returns the best chunk per page, so chunk-level recall can sit just under 1 with a perfect index. Also `index_scans` and `ann_index`. |
| `vector_filtered_10` | `searchVector` with `sourceId: 'scale-b'` (10% of pages). Recall against a filtered exact scan for the first 50 queries (not timed). |
| `vector_filtered_1` | The same with one `type` as well. See the selectivity note below. |
| `put_page` | Rewrites a random existing page with its own text and vectors (`force: true`): one transaction, 4 chunks. The corpus does not change. |
| `write_w1/w4/w16` | 1/4/16 writers for 5 s, each inserting new `bench/...` pages (4 chunks, vectors from random corpus rows) in one transaction each. Reports `conflicts`, `retries`, `busy`, `errors`. |
| `write_hot_w16` | 16 writers increment one counter in a page's frontmatter. Each iteration, in one transaction: `getPage`, then `putPage` with `expectedRevision` (gbrain's compare-and-swap). A conflict retries the whole transaction. `final_equals_committed` is the lost-update check. |
| `write_hot_w16_unguarded` | Extra. The same counter with a naive `getConfig`/`setConfig` read-modify-write, i.e. code that does not use the revision check. `lost_updates` is committed minus final. |
| `crash_recovery` | A child writes new pages and prints `ACK <slug>` after each commit. The parent counts the acks it read, SIGKILLs the child about 2 s after it is ready, reopens, and reports `acked`, `lost`, `reopen_ms`, `consistent`, `unacked_committed`, `writable_after`. |
| `second_process` | While this process owns the store, a child tries `createEngine` + `connect`. Reports `outcome`, `owner_still_ok`. |
| `disk_bytes` | PGLite: size of the data dir (after import and after writes). Postgres: `pg_database_size` plus cluster WAL size. Both: size of `content_chunks`, `pages` and the HNSW index. |
| `peak_rss_bytes` | The runner's VmHWM. For Postgres also the postmaster's process tree sampled every second (summed PSS when readable, else RSS). |

## Result file

`gbrain-bakeoff-result/1` with the spec's fields, plus `versions` (bun, pglite, server, pgvector, gbrain),
`server_settings` (shared_buffers, fsync, synchronous_commit, ...), `store_after` (page and chunk counts after the
write metrics), and `notes`. `variant` records the HNSW mode, import workers, pool size and `quick`.

## Caveats

- **PGLite has one connection.** `read_c4/c16` and `write_w4/w16` measure serialized clients, not parallel ones; that
  is the engine's real behavior and the point of the comparison. Latency under load rises with the client count.
- **HNSW modes.** `inline` (default) is what gbrain does: the index exists while pages are imported, so every insert
  updates the graph. `deferred` drops `idx_chunks_embedding` first and builds it after the import (timed in
  `hnsw_build_seconds`, with `withHnswBuildMemory` sizing PGLite's build memory); `skip` leaves no index. The result's
  `variant` and `import` metric say which one ran.
- **Warm cache.** Every metric runs with a warm OS file cache; `cold_open` measures a cold process only.
- **Filtered selectivity.** In the dbpedia corpus the source and the type are correlated (page index % 10 and % 4):
  `scale-b` holds only `person` and `note` pages. `vector_filtered_1` therefore filters scale-b plus `note`, which is
  5% of pages rather than the spec's 2.5%. The metric reports the real `selectivity`.
- **Crash test on Postgres is client-only.** Killing the writer cannot lose a commit the server acknowledged and does
  not test a server crash or power loss. For PGLite the writer process hosts the database, so the kill is a real crash.
- **PGLite durability.** PGLite reports `fsync=off`; its commits are not fsync-confirmed the way Postgres WAL
  commits are, so its write latency is not a like-for-like durable commit.
- **Second process.** The check is a direct open of the PGLite data dir while another process owns it. The owner-socket
  client path is not measured. PGLite waits 30 s for the lock and then refuses.
- **Peak RSS.** `process_bytes` includes the corpus the runner holds in memory (`harness_overhead_rss_bytes`). Exact
  ground truth is computed in a child process so it does not inflate the peak. Postgres server RSS is a sampled peak.
- **Shared machine.** Timings are noisy if peers run builds at the same time. Run each result you quote more than once.

## Time and the PGLite ceiling

The PGLite import is slow because every insert updates the HNSW graph and PGLite is one wasm thread; the rate also
falls as the graph grows. pglite.wasm has a 2 GiB heap, and an HNSW build holds the whole graph in memory, so gbrain
refuses to build one for much more than 300k 1,024-dim chunks (`docs/ENGINES.md`, "PGLite vector index ceiling").
Use `--hnsw deferred` for large PGLite runs; compare with `inline` only at 10k.

## Export a private brain

`rust/scripts/export-corpus.ts` writes any existing brain in the corpus format so the same runners can use it:
`bun rust/scripts/export-corpus.ts --out <dir outside any repo> [--database-url ... | --pglite-dir ...]`.
The export holds private text. It is written 0600, refuses a directory inside a git working tree, and must never be
committed or shared; only aggregate numbers may be published. The script counts a directory as outside a repository
only when git, run with `LC_ALL=C` and `LANG=C`, exits 128 with its exact `not a git repository` message. Any other
answer (git missing, unsafe ownership, a message in another language) refuses too; `--allow-in-repo` skips the check.
Its queries are sampled from stored chunks, so they are in the corpus (`queries_in_corpus: true`).
`roundtrip-check.ts` verifies an export against the corpus it came from.
