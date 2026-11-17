# gbrain-bakeoff: record-store bake-off for the Rust engine

This crate answers one question: which embedded key-value store should sit under gbrain's Rust
engine? It runs the same workload against redb, fjall and LMDB (through heed), each under the
same gbrain-owned optimistic transaction layer, and writes one JSON result file per run in the
shared `gbrain-bakeoff-result/1` format. The TypeScript baseline (`../baseline/`) writes the same
format for PGLite and Postgres, so the files can be compared side by side.

The numbers are raw store numbers. They do not include the napi crossing or the TypeScript
wrapper that a real gbrain call goes through, so treat them as a floor on latency, not a promise.

This crate is its own Cargo workspace (see the `[workspace]` table in `Cargo.toml`) and is not
part of `rust/Cargo.toml`.

## How the optimistic layer works

Each store only has to provide an ordered key-value table, point-in-time snapshots and one atomic,
fsynced write batch. Everything else is gbrain's own code in `src/occ.rs`, shared by all three
stores. A transaction reads from a snapshot, so readers never block. It remembers every key and
key range it read and buffers its writes in memory. On commit it is sent to one commit-pipeline
thread. For each transaction, in arrival order, the pipeline checks whether anything the
transaction read was written after its snapshot, by an earlier commit or by an earlier
transaction in the same batch. If so, the caller gets a typed `Conflict`; if not, the transaction
gets the next commit version. The accepted transactions of one round go to the store as a single
durable write (group commit), together with the commit log (version to write set) and the
`meta/version` counter, and callers are acknowledged only after the fsync. Typed operations
(`Db::run`) re-run on a conflict from a fresh snapshot with a bounded number of attempts and
randomized backoff, so a caller never sees a "busy" error. Blind writes and atomic adds
(`add_i64`) read nothing and therefore never conflict, which is the answer for hot counters. The
layer remembers only a bounded window of recent writes; a transaction older than that window is
treated as a conflict instead of risking a missed one. A deterministic, seeded simulation in
`src/sim.rs` checks that every committed history can be replayed in commit order and reproduces
what each transaction read.

## What is measured

Metric names match the shared spec. Run `gbrain-bakeoff list-metrics` for the exact ids you can
pass to `--only`.

| Metric | What it measures |
| --- | --- |
| `import` | Bulk load of all pages, chunks and vectors (one durable commit per ~1,000 chunks). Includes parsing the corpus files. |
| `cold_open` | A fresh process opens the store and does its first `get_page` (median of 3). The OS file cache is warm; this is a cold process, not a cold cache. |
| `get_page`, `read_c1/c4/c16` | Point read by (source, slug), single client, then 1, 4 and 16 clients for a fixed 5 s. |
| `list_pages` | 100 pages in slug order from a random start, inside one source. |
| `get_chunks` | All chunks with vectors of a random page. |
| `vector_exact`, `vector_exact_mt` | Exact top-10 over all chunks for 200 queries, single thread and all cores, with recall against exact ground truth. The matrix is loaded from the store (`load_ms`). |
| `vector_filtered_10`, `vector_filtered_1` | The same scan restricted to source `scale-b`, and to one page type inside `scale-b`. The metric reports the measured `selectivity`. |
| `put_page` | Upsert one existing page and replace its chunks with 4 fresh 1,024-dim vectors, single writer, durable. |
| `write_w1/w4/w16` | Durable write transactions per second with 1, 4 and 16 writers, each writing its own new pages, for 5 s. Reports `conflicts`, `retries`, average batch size. |
| `write_hot_w16` | 16 writers doing read-modify-write on one counter. Checks that the final counter equals the acknowledged commits (no lost update); the run exits non-zero if not. |
| `write_hot_w16_atomic` | The same with the conflict-free atomic add. |
| `crash_recovery` | A child process writes continuously and is SIGKILLed after about 2 s; the parent reopens. `lost` counts acknowledged commits that are missing or changed; `consistent` is a whole-store structural check (chunk counts, orphans, page-id index, commit-log contiguity). |
| `second_process` | While the owner holds the store, a second process tries to open it directly (`outcome` says refused or opened), and then four client processes talk to the owner over a Unix socket (`client_get_page_p50_ms`, `client_errors`). |
| `disk_bytes` | Bytes on disk after import and after the write tests. |
| `peak_rss_bytes` | `ru_maxrss` of the harness process. It includes the in-memory vector matrix and the store's own cache. |

Notes that matter when reading the numbers:

- Every acknowledged commit is fsynced on every store (redb `Durability::Immediate`, LMDB default
  flags, fjall `PersistMode::SyncAll`).
- The commit log is on by default, so each write is stored twice (record plus log entry). Run with
  `--no-commit-log` (variant `occ-group-commit-nolog`) to see what that costs.
- The vector scan is an exact brute-force scan over an in-memory f32 matrix, not an ANN index.
  The kernel is built portably and picks AVX2+FMA at run time when the CPU has it; the metric
  records which path ran (`simd`). Approximate search (usearch or an own HNSW) is a follow-up that
  we decide after the stores reach parity; `vector_ann` is not measured here.
- `vector_filtered_1` is meant to be about 2.5% of chunks. In the current corpus `scale-b`
  contains only the types person and note, so the largest single type is about 5%. The metric
  reports the measured selectivity and the run adds a note.
- The `second_process` direct open is a probe only. LMDB lets a second process open and read the
  files, but a write through it would bypass the commit pipeline (and its conflict checks), so we
  do not write that way. The owner-socket path is the design for more than one process.
- LMDB limits keys to 511 bytes, so a page slug longer than roughly 500 bytes cannot be stored (LMDB's default build limit; not exercised by these runs).
- A Fjall `OptimisticTxDatabase` variant (the store's own optimistic transactions) was not built.
- The machine may be shared with other benchmark runs; write numbers (fsync bound) are sensitive
  to that. The result file records the machine and a start time, not the load.

## Run it

Needs a Rust toolchain (stable). From this directory:

```sh
cargo build --release
B=target/release/gbrain-bakeoff

# Corpus: built by ../corpus (format gbrain-bench-corpus/1). Exact ground truth is computed once
# and cached as <corpus>/truth_top10.json (shared with the TypeScript baseline):
$B truth --corpus /path/to/corpus-10k

# One engine, one scale. `import` wipes and recreates --store, then every other metric runs.
$B run --engine redb  --corpus /path/to/corpus-10k --store /var/tmp/bench/redb-10k  --scale 10k --out redb-10k.json
$B run --engine fjall --corpus /path/to/corpus-10k --store /var/tmp/bench/fjall-10k --scale 10k --out fjall-10k.json
$B run --engine lmdb  --corpus /path/to/corpus-10k --store /var/tmp/bench/lmdb-10k  --scale 10k --out lmdb-10k.json

# The same at 200k chunks:
$B run --engine redb  --corpus /path/to/corpus-200k --store /var/tmp/bench/redb-200k --scale 200k --out redb-200k.json
```

Options for `run`:

- `--quick` divides operation counts by 10 and shortens timed runs to 1 s (for smoke tests only).
- `--only import,get_page,vector_exact` runs a subset. Without `import` the store must already exist.
- `--no-commit-log` turns the commit log off.

Exit status is 0 when the run finished and every correctness check held (no lost update on the hot
counter, nothing lost and the store consistent after the crash, no errors on the owner socket),
1 when a check failed (the JSON is still written), 2 for bad arguments. A metric that cannot be
measured appears as `{"n":0,"error":"..."}`; a store that cannot meet a requirement is a result,
not a crash.

## Tests

```sh
cargo test                                  # unit tests, the seeded simulation, store contract tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`src/contract_tests.rs` runs the same checks against redb, fjall, LMDB and the in-memory store
(snapshot isolation, ordered range scans, reopen, the consistency checker). Test stores are
created under `target/test-tmp/`.

## Layout

- `src/kv.rs`: the base-store contract. `redb_store.rs`, `fjall_store.rs`, `lmdb_store.rs`,
  `mem_store.rs` implement it.
- `src/occ.rs`: the optimistic layer (transactions, conflict index, commit pipeline).
- `src/keys.rs`, `src/records.rs`: key layout and the page/chunk record layer.
- `src/corpus.rs`, `src/vector.rs`: corpus reader, exact scan, ground truth.
- `src/owner.rs`: the owner socket (one process owns the store, others are clients).
- `src/workload.rs`, `src/children.rs`, `src/main.rs`: the metrics, the child processes
  (cold open, crash writer, second-process probe, socket clients) and the CLI.
