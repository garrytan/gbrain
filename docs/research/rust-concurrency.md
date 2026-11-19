# Many writers on one Rust brain: research, benchmark and prototype

Status: research plus a working prototype on branch `rust-engine/concurrency-proto` (from master
`41e33807b6`). Rust only; no TypeScript change, no flag. Measured 2026-11-18 on one 8-core Linux
machine with a network disk (one `fdatasync` takes about 3 ms).

This builds on `docs/research/rust-engine/multi-user-prior-art.md`. That note recommends
FoundationDB-style optimistic transactions (OCC) with one ordered commit pipeline and group commit,
and asks the bake-off to measure "lock wait, conflict retries, p99 at 1, 4, 16 and 64 writers".
This note does that measurement and builds the recommended design inside `gbrain-store`.

## TL;DR

We learned that the store's single writer, not the disk, is what makes many agents slow: today
each extra writer adds wait, and the wait is unfair (p99 of 1-6 seconds at 16-64 writers).
Optimistic transactions with one group-commit pipeline remove that wait without changing any
result, and a small in-memory row-lock queue keeps a hot page from starving its writers. You
should adopt the prototype's design (OCC + one ordered group-commit pipeline + queue-on-conflict)
for the Rust store, then measure fjall as the base store, because redb's copy-on-write writes
cap how much group commit can save.

Headline numbers (this machine, two runs each, 0 errors everywhere):

- **Owner-protocol bench** (the same bench Ember used as the baseline: N client processes,
  alternate `putPage`/`getPage` through the owner socket, 1000 ops each). Today: 910 / 762 / 602
  / 520 ops/s at 1 / 4 / 16 / 64 clients. Prototype: 886 / 1363 / 976 / 826 ops/s. That is 1.6-1.8x
  at 4-64 clients, with p99 down from 16 / 58 / 249 ms to 10 / 36 / 155 ms.
- **Store bench** (threads call `gbrain-store` directly; one op = page mutation + 4 chunks + 3
  links = 3 commits). Disjoint pages at 64 writers: today 37 ops/s, p99 6.4 s; prototype 236
  ops/s, p99 0.45 s (6.3x). One hot page at 64 writers: today 84 ops/s, p99 5.3 s; prototype
  101-111 ops/s, p99 1.5-1.7 s. Every write still lands exactly once, in an order Postgres could
  have produced.
- **Raw key-value tier** (same transaction shape on redb, LMDB and fjall). Under OCC + group
  commit at 64 disjoint writers: redb 604 ops/s, LMDB 700, fjall 5959. A single serialized writer
  stays flat at 183-291 ops/s on every engine.

## What gbrain relies on from Postgres, and the embedded answer

The prior-art note's lock and queue table (its section "Lock and queue mapping") maps every site.
This table groups those sites by the Postgres semantic they depend on, and says which part the
prototype builds now and which part is still design only.

| Postgres semantic | What gbrain uses it for | Embedded answer | In the prototype |
|---|---|---|---|
| Row locks (`SELECT ... FOR UPDATE`, then `UPDATE`); a second writer of the same row waits, then sees the first writer's result | Page read-modify-write (`putPage`, the write journal, versions, chunks, tags, links, timeline); about 225 `FOR UPDATE` sites | Each transaction reads at a snapshot and records its read set. The commit pipeline rejects a transaction whose reads changed; `Store::write` reruns it from a fresh snapshot. Before the rerun it takes an in-memory lock on the key it lost on, so later writers of that key queue behind it as on a Postgres row lock. The result equals running the committed transactions one after another (serializable). | Yes: `occ_kv.rs` (`OccKv`, `KeyLocks`), `Store::write` in `lib.rs` |
| `FOR KEY SHARE` on the parent page while links and timeline rows are written | A purge must not race a link write | The parent page key is in the link writer's read set, so one of the two fails validation and reruns | Yes (read sets cover every key the store reads) |
| `nextval` / `bigserial` | Version ids, journal sequence, chunk ids | `allocate`: handed out from memory, written as a monotonic max (`Op::Max`), never conflicts. A rerun or an abort leaves a gap, as in Postgres. | Yes (`tx.allocate`) |
| Counters updated by many writers | Chunk stats, journal outstanding counts | `add_i64`: an atomic add that reads nothing, so it never conflicts | Yes (`chunk_stats/*`, `journal_outstanding/*`) |
| `pg_advisory_xact_lock` around a count-then-insert (admission, quota, max-waiting) | `minions/queue.ts` near lines 385, 431, 460; write-journal admission | `counter_below(key, cap)`: the check goes into the read set as a predicate, and conflicts only when a later commit changes its answer | Yes for write-journal admission (`journal.rs`); the job queue is not built in Rust yet |
| `FOR UPDATE SKIP LOCKED` job claim | `minions/queue.ts` lines 1511, 1585 | Read the ready index at a snapshot and claim with a write to the job's claim key. Two claimers of one job conflict; the loser takes the next job, with no wait. A batch claim from the owner process when contention is high. | No: `jobs.rs` says "Nothing is built yet". Uses only primitives the prototype has. |
| `LISTEN/NOTIFY` (`notify_minion_job_change`) | Waking idle workers | A subscription on the commit pipeline: a waiter registers a key range; the pipeline wakes it after a commit that touches the range. Across processes the owner pushes over its socket. | No; the pipeline is the natural place (it already knows every committed key) |
| `REPEATABLE READ` reads | `getPageAsOf` (`src/core/ops/valid-time-read.ts:320`), `ops/pages.ts:167`, `export.ts:113` (`READ ONLY`), `persistence/sync-pass.ts:382` | One store snapshot per call (`Store::read`). A snapshot never blocks and is never blocked; a read-only transaction commits without validation. | Yes for every store read; the Rust store has no as-of read yet, and it will get the same single snapshot |
| Advisory lock 42 around schema init and migration | Format upgrades | Compare-and-set on the format record; one process wins | Unchanged (format upgrade is not a hot path) |
| A failed WAL flush stops the server | Durability | A failed batch commit stops the pipeline: later commits fail with `store_io` until the brain is opened again | Yes |

## Options compared

Four options from the brief, plus today's store:

1. **Today**: redb's single writer. `begin_write` blocks until the previous writer commits; each
   commit is one fsync.
2. **Single writer + group commit**: still one writer, but many callers' writes go into one
   fsync. On its own this needs callers that do not read what they write, which gbrain's writes
   do (every page write reads the page). It becomes option 3 as soon as it must check reads.
3. **OCC with a commit-time conflict check** (the prototype): snapshot reads, a read set, one
   ordered pipeline that validates and group-commits.
4. **Sharded redb**: K redb files, a page lives in file `page % K`, one writer per file.
5. **fjall or LMDB** as the base store, with a serialized writer or under the same OCC layer.

### How it was measured

Three tiers, from closest to the product to closest to the disk. Each point is one run of fixed
length; the owner and store tiers were each run twice (both runs below or averaged). Throughput
varied by up to 10% between runs, p99 by more. Errors were 0 everywhere except where the table
says so.

- **Owner tier**: `scripts/bench-rust-owner.ts` from `rust-engine/owner-protocol` at
  `e58b0795e8` (Ember's baseline), built twice: once as it is, once with this branch's
  `rust/crates` applied on top (the owner branch changes no Rust). 1000 ops per client.
- **Store tier**: `rust/concurrency-bench` `store-bench`, 5 s per point, against master's store
  and against the prototype.
- **Raw tier**: `rust/concurrency-bench` `rawkv-bench`, 3 s per point, through the bake-off
  crate's engines. One transaction reads a page and a counter and writes about 10 KB over 11 keys
  (page, version, counter, journal, 4 chunks, 3 links).

### Owner tier (the 1-writer row is Ember's baseline bench)

Ember measured today's store at 675 / 640 / 645 ops/s at 1 / 4 / 16 clients, and 568 ops/s with
p99 108 ms at 16 x 1000, on another machine. On this machine the same bench gives:

| Clients | Today ops/s | Today p50 / p99 ms | Prototype ops/s | Prototype p50 / p99 ms | Prototype / today |
|---|---|---|---|---|---|
| 1 | 908 / 911 | 1.1 / 4.3 | 899 / 872 | 1.0 / 4.4 | 0.98x |
| 4 | 763 / 760 | 2.2 / 16.1 | 1375 / 1350 | 1.5 / 10.4 | 1.79x |
| 16 | 587 / 616 | 25.8 / 58.4 | 973 / 979 | 16.0 / 36.4 | 1.62x |
| 64 | 517 / 523 | 120 / 249 | 856 / 795 | 75 / 155 | 1.59x |

(Two runs each, "run 1 / run 2" for ops/s, averaged for latency. Every run wrote all its pages
and found them again; 0 errors.)

Today's throughput falls as clients are added; the prototype's rises at 4 clients and then falls
more slowly. Above 4 clients the prototype is no longer limited by the store: half the ops are
reads, the owner runs at most 32 calls at once (`OWNER_IPC_DEFAULT_PERMITS`), and 16-64 Bun client
processes share 8 cores with the owner's single event loop. I did not profile the owner process;
the store tier below shows what the store alone does.

### Store tier (threads on one `Store`, 3 commits per op)

| Store | Workload | Writers | ops/s (run 1 / run 2) | p50 ms | p99 ms | Conflicts per op | Txns per fsync |
|---|---|---|---|---|---|---|---|
| today | disjoint | 1 | 70.0 / 71.1 | 17.6 | 20.1 | – | 1 |
| today | disjoint | 4 | 49.8 / 46.9 | 21.1 | 1432 | – | 1 |
| today | disjoint | 16 | 40.8 / 41.6 | 27.6 | 3152 | – | 1 |
| today | disjoint | 64 | 37.5 / 37.1 | 29.7 | 6425 | – | 1 |
| proto | disjoint | 1 | 66.5 / 66.2 | 15.4 | 18.4 | 0 | 1.0 |
| proto | disjoint | 4 | 74.5 / 76.7 | 56.9 | 61.6 | 0 | 2.0 |
| proto | disjoint | 16 | 119.4 / 121.5 | 144 | 198 | 0 | 9.2 |
| proto | disjoint | 64 | 236.1 / 237.1 | 281 | 450 | 0 | 58.7 |
| today | hot | 1 | 88.0 / 84.5 | 11.6 | 13.4 | – | 1 |
| today | hot | 4 | 81.5 / 84.9 | 13.2 | 691 | – | 1 |
| today | hot | 16 | 82.4 / 84.1 | 12.7 | 4709 | – | 1 |
| today | hot | 64 | 84.3 / 84.1 | 12.9 | 5383 | – | 1 |
| proto | hot | 1 | 116.7 / 109.2 | 8.6 | 12.3 | 0 | 1.0 |
| proto | hot | 4 | 123.6 / 107.7 | 23.1 | 147 | 2.97 | 1.0 |
| proto | hot | 16 | 117.8 / 117.5 | 121 | 376 | 3.03 | 1.0 |
| proto | hot | 64 | 111.0 / 101.2 | 504 | 1528 | 3.00 | 1.0 |

Latencies are from run 1; run 2 was within 15% except today's p99, which swings by seconds
(for example 4709 ms then 1735 ms at hot 16), because it measures who loses an unfair lock.

Today never returns a busy error inside one process: writers wait on redb's write lock. The
wait is the cost. Its p50 stays flat while its p99 grows to the length of the run, so a few
writers wait for seconds while others go round again.

In the prototype the hot page conflicts about once per commit (3 per op): each writer's first,
optimistic try loses, and the rerun queues on the page key and then commits. The conflicts are
cheap (the first try stops at its first read of a queued key), they are invisible to the caller,
and no write came near the limit of 1000 reruns: 0 errors. A hot page cannot commit faster
than one writer at a time, as in Postgres, so the gain there is fairness (p99 5.4 s to 1.5 s),
not throughput.

### Raw tier (key-value engines, 1 transaction = 11 keys, about 10 KB)

ops/s at 1 / 4 / 16 / 64 writers, then p99 ms at 64 writers:

| Design | Disjoint ops/s | p99 @64 | Hot ops/s | p99 @64 | Hot: errors @64 |
|---|---|---|---|---|---|
| serial/redb | 239 / 182 / 183 / 183 | 3299 | 289 / 217 / 223 / 223 | 3256 | 0 |
| sharded4/redb | 231 / 213 / 199 / 196 | 2203 | 225 / 226 / 225 / 225 | 3258 | 0 |
| sharded16/redb | 288 / 293 / 273 / 264 | 2582 | 231 / 234 / 234 / 233 | 3258 | 0 |
| serial/lmdb | 233 / 232 / 232 / 232 | 3235 | 224 / 238 / 232 / 222 | 3217 | 0 |
| serial/fjall | 290 / 294 / 283 / 291 | 3168 | 291 / 290 / 289 / 296 | 3166 | 0 |
| occ/redb | 156 / 293 / 344 / 604 | 247 | 264 / 226 / 204 / 212 | 1297 | 63 |
| occ/lmdb | 229 / 261 / 404 / 700 | 239 | 207 / 233 / 249 / 250 | 988 | 95 |
| occ/fjall | 319 / 651 / 1134 / 5959 | 70 | 270 / 294 / 327 / 320 | 938 | 124 |

Average transactions per fsync under OCC at 64 disjoint writers: redb 49, LMDB 52, fjall 37. The
occ/redb 1-writer point (156 ops/s, p99 20 ms) was 228 ops/s in an earlier run; treat it as noise.
A p99 near 3 s in the serial rows is the length of the run: some writers waited the whole run.

The `occ/*` rows use the bake-off's OCC layer (`rust/bench/src/occ.rs`): rerun with randomized
backoff, at most 200 tries, and no queueing. On the hot page that layer starves: 38-42 conflicts
per committed transaction at 64 writers, and 63-124 transactions gave up in 3 s (an error the
caller would see). The prototype store fixes exactly this with queue-on-conflict; see the store
tier's hot rows (3 conflicts per op, 0 errors).

## What the numbers say

1. **The writer lock is the bottleneck, and it is unfair.** Every serialized design (today,
   `serial/*`, each shard) holds throughput flat while p99 grows to seconds. Neither redb's write
   lock nor a `std::sync::Mutex` hands the lock out in arrival order.
2. **Group commit is where the throughput comes from, and validation is what makes it legal.**
   With disjoint writers the prototype puts 9 transactions into one fsync at 16 writers and 59
   at 64. Throughput grows with writers instead of falling.
3. **redb limits how much group commit saves.** A redb batch of about 9 transactions took about
   24 ms against 3.7 ms for one. With `strace` at 16 writers: 415 fsyncs averaging 6.7 ms, and
   about 51 KB written per commit for about 10 KB of data (66 KB per commit with one writer).
   redb copies every B-tree page it changes up to the root, so a batch that touches more distinct
   pages writes more, and the pipeline thread spends its time waiting on the disk. The same OCC
   layer on fjall (an LSM tree that appends to a journal) reached 5959 ops/s at 64 writers, 10x
   redb.
4. **Sharding helps a little and costs a lot.** sharded16 gains 44% at 64 disjoint writers and
   nothing for a hot page (all its writers land in one shard). A transaction that spans shards
   (a link to a page in another file, the global journal, a counter) is no longer atomic, so
   sharding would need two-phase commit to keep Postgres results. Not worth it.
5. **Pure OCC is not enough for gbrain's write pattern.** gbrain writes the same few pages a lot
   (a daily note, an entity page many agents update). Rerun-with-backoff gives up under that
   load; queue-on-conflict does not. Postgres has the same split: OCC-style at the
   `SERIALIZABLE` level, row-lock queueing for `FOR UPDATE`. The prototype uses both.

## The prototype

Code on `rust-engine/concurrency-proto`, all in `rust/crates/gbrain-store`:

- `src/occ_kv.rs` (new): `OccKv` over `RedbKv`. Snapshot reads, read set of keys and ranges,
  buffered writes, one `gbrain-commit-pipeline` thread that validates in arrival order and commits
  each round as one durable redb write (at most 512 transactions or 64 MiB per round). Typed ops
  that never conflict: `allocate` (sequences), `add_i64` (counters), `counter_below` (admission
  caps). `KeyLocks` queues reruns on the key they lost. `OccStats` counts commits, conflicts,
  batches and the hottest keys.
- `src/lib.rs`: the store opens `OccKv` by default. `Store::write` takes an `FnMut` and reruns it on
  `write_conflict` (an internal code; callers never see it unless 1000 reruns fail).
- `journal.rs`, `chunks.rs`: shared counters that every writer used to read-modify-write as one
  JSON value are now separate `add_i64` counters (`journal_outstanding/*`, `chunk_stats/*`), so
  writes to different pages no longer conflict on them. The old JSON values are read as a base.
- `pages.rs`, `timeline.rs`, `page_body.rs`: id sequences use `allocate`.

Tests (all pass in debug; `cargo clippy --workspace --all-targets` is clean):

- `tests/concurrency.rs`, 16 writer threads (32 for admission):
  `writers_of_one_page_serialize_and_each_update_lands_once`,
  `concurrent_tags_links_and_timeline_entries_are_all_kept`,
  `concurrent_chunk_writes_to_one_page_are_never_mixed`,
  `the_same_request_submitted_concurrently_is_applied_once`,
  `admission_limits_hold_under_concurrency`,
  `concurrent_submissions_to_disjoint_pages_all_commit`.
- `lib.rs` `concurrency_tests`:
  `a_write_does_not_wait_for_another_open_write_on_other_keys` (non-conflicting writers commit in
  parallel), `a_write_whose_read_went_stale_runs_again_and_is_the_last_writer`,
  `read_modify_write_increments_from_many_threads_are_never_lost`,
  `write_skew_is_refused_as_serializable_postgres_would`.
- Every gbrain-store test binary passes: 62 lib tests (the 4 above included), `tests/sim.rs`
  (updated for the new counter keys) and the rest.

## Caveats and losses

- **One machine, one disk.** fsync here is about 3 ms. On a laptop NVMe disk fsync is often
  under 1 ms, which raises every serialized number and shrinks the group-commit gain; on slower
  disks the gain grows. Each point is one or two runs, not a distribution.
- **One writer is not faster.** At 1 writer the prototype is within noise of today (owner tier
  0.98x; store tier 66 against 70 ops/s disjoint). Its gain starts at 4 writers.
- **A hot page is still one writer at a time.** That is the Postgres result too, and it is what
  "Postgres-equal output" requires; the prototype only makes the line fair.
- **File format.** The new counters live under new keys. A binary from master reads only the old
  JSON counters, so it would read stale counts from a brain this code wrote. A format-version bump
  is needed before this ships.
- **Order of journal ids.** Journal sequence numbers are handed out at allocation, not at commit,
  so across disjoint writers they are not in commit order (the same as a Postgres `bigserial`).
  Version ids per page stay monotonic. Reruns leave gaps in ids.
- **Not built**: the job queue (`SKIP LOCKED`), wake subscriptions (`LISTEN/NOTIFY`) and as-of
  reads. The table above maps them to primitives the prototype has; they were out of scope.
- **Vectors were not in the write.** `upsert_chunks` does not store embeddings, so the benchmark
  has no vector cost.
- **The owner tier mixes in things the store does not control** (IPC, the 32-permit pool, Bun
  processes on 8 cores). I did not profile why the prototype's gain there falls from 1.8x at 4
  clients to 1.6x at 64.
- **Not done**: the deterministic simulation and Elle-style history check that the prior-art note
  asks for. The prototype's tests check outcomes under real threads, which finds bugs but does
  not prove their absence.
- **A future change, not done**: `raise_latest` in `timeline.rs` reads and rewrites a "latest"
  marker; it could become an `Op::Max`-style raise so it never conflicts.

## Recommendation

Adopt the prototype's design for the Rust store: optimistic transactions with one ordered
group-commit pipeline, typed non-conflicting ops for ids, counters and admission caps, and
queue-on-conflict for hot keys. It is the only option measured that raises throughput with more
writers (6.3x at 64 disjoint writers in the store, 1.6-1.8x through the owner protocol). It cuts
store p99 at 64 writers from 6.4 s to 0.45 s for disjoint pages and from 5.4 s to 1.5 s for one
hot page (1.6x lower through the owner protocol). It returns no busy error, and keeps every result equal to a serial (Postgres) order.
Do not shard. As the next step, put fjall under the same layer and run this benchmark again: on
the raw tier it was 10x redb at 64 writers, because redb's copy-on-write commits are what the
pipeline waits on. Before shipping, bump the format version for the new counter keys and add the
deterministic simulation with a history checker.

## Reproduce

```bash
cd rust/concurrency-bench
cargo build --release --features raw
./target/release/store-bench --secs 5                # today: one writer at a time
./target/release/store-bench --concurrent --secs 5   # concurrent_writes on
./target/release/rawkv-bench --secs 3

# Owner tier: in a checkout of rust-engine/owner-protocol (e58b0795e8), once as it is and once
# with this branch's rust/crates copied in:
bun install && bun run rust:build
GBRAIN_RUST_ENGINE_ADDON=$PWD/rust/target/addon/gbrain_engine.linux-x64-glibc.node \
  bun scripts/bench-rust-owner.ts --clients 16 --ops 1000
```
