# Many writers on one Rust brain: research, benchmark and prototype

Status: research plus a working prototype, first on branch `rust-engine/concurrency-proto` (from
master `41e33807b6`), then hardened on `rust-engine/concurrency-proto-2`. Many-writer commits are
opt-in (`GBRAIN_RUST_CONCURRENT_WRITES=1`, default off). The fjall store is a bake-off behind the
off-by-default cargo feature `fjall`. Measured 2026-11-18 on one 8-core Linux machine with a
network disk (one `fdatasync` takes about 3 ms).

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

fjall bake-off (the whole gbrain store on fjall under the same OCC layer, three runs per point;
see "fjall bake-off" below): at 64 disjoint writers the store does 1629 ops/s against 219 on redb
(7.4x), p99 80 ms against 500 ms. Through the owner protocol at 64 clients: 1350 against 606 ops/s
(2.2x). It loses at one client (0.6x of redb), and it ties redb on one hot page. 837 of 839 store
tests pass on it; the 2 that fail open the redb file by name. We learned that fjall is the base
store to move to. You should do that after the Dec 1 parity work, behind the same flag and not as
the default. A process-kill check now passes on fjall; a power-loss check still does not exist.

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

- **Owner tier**: the owner bench `bench-rust-owner.ts` from `rust-engine/owner-protocol` at
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
- `src/lib.rs`: the store opens `OccKv` when `OpenOptions::concurrent_writes` is set (the addon
  sets it from `GBRAIN_RUST_CONCURRENT_WRITES=1`; default off). `Store::write` takes an `FnMut` and reruns it on
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

## fjall bake-off (concurrency-proto-2)

`src/fjall_kv.rs` puts the whole gbrain store on fjall 3.1 (an LSM tree that appends to a
journal). It builds only with the cargo feature `fjall` (off by default) and is picked at run time
by `GBRAIN_RUST_BAKEOFF_STORE=fjall`, which opens `records.fjall` in place of `records.redb`.
`FjallKv` gives the same `Kv` contract as `RedbKv`: snapshot reads, one write transaction at a
time that reads its own writes, and a durable commit (`PersistMode::SyncAll`) that also writes a
commit sequence in the same batch. With the flag on, `OccKv` runs over it unchanged, so the
concurrency design, the typed ops and the queue-on-conflict are the same code on both stores.
Nothing in a default build or a default run changes.

Tests: the full `gbrain-store` suite on fjall (`GBRAIN_RUST_BAKEOFF_STORE=fjall cargo test -p
gbrain-store --features fjall`) passes 837 of 839, with the flag off and with it on. The 2 that
fail are redb harness tests: `an_unknown_format_is_refused_before_the_records_are_touched` reads
`records.redb` by name, and `a_format_1_brain_is_upgraded_on_open_and_keeps_its_counts` builds its
format-1 brain with `RedbKv`. The simulated-disk crash and fsync runs in `tests/occ_history.rs`
run only on redb; the process-kill runs below are the fjall counterpart.

Store tier (5 s per point, three runs, 0 errors in every run; p50 and p99 are the mean of the
three runs; "serial" is one writer at a time, "OCC" is the flag on):

| Store | Workload | Writers | ops/s (runs 1 / 2 / 3) | p50 ms | p99 ms | Conflicts per op | Txns per fsync |
|---|---|---|---|---|---|---|---|
| redb serial (today) | disjoint | 1 | 69 / 69 / 71 | 17.4 | 20 | – | 1 |
| redb serial (today) | disjoint | 4 | 42 / 44 / 44 | 25.3 | 988 | – | 1 |
| redb serial (today) | disjoint | 16 | 39 / 39 / 39 | 41.3 | 3846 | – | 1 |
| redb serial (today) | disjoint | 64 | 35 / 34 / 35 | 789.6 | 6374 | – | 1 |
| redb OCC | disjoint | 1 | 64 / 64 / 64 | 15.9 | 20 | 0 | 1.0 |
| redb OCC | disjoint | 4 | 71 / 72 / 68 | 60.4 | 67 | 0 | 2.0 |
| redb OCC | disjoint | 16 | 110 / 114 / 114 | 147 | 207 | 0 | 9.1 |
| redb OCC | disjoint | 64 | 222 / 215 / 221 | 290.5 | 500 | 0 | 60.1 |
| fjall serial | disjoint | 1 | 90 / 96 / 88 | 10.9 | 12 | – | 1 |
| fjall serial | disjoint | 4 | 96 / 95 / 92 | 11.3 | 546 | – | 1 |
| fjall serial | disjoint | 16 | 93 / 93 / 95 | 11.1 | 1830 | – | 1 |
| fjall serial | disjoint | 64 | 93 / 93 / 91 | 13.3 | 4834 | – | 1 |
| fjall OCC | disjoint | 1 | 118 / 120 / 119 | 8.3 | 12 | 0 | 1.0 |
| fjall OCC | disjoint | 4 | 251 / 246 / 254 | 15.8 | 22 | 0 | 2.0 |
| fjall OCC | disjoint | 16 | 723 / 720 / 718 | 23.1 | 30 | 0 | 8.8 |
| fjall OCC | disjoint | 64 | 1626 / 1630 / 1632 | 36.8 | 80 | 0 | 58.4 |
| redb serial (today) | hot | 1 | 80 / 80 / 81 | 12.8 | 14 | – | 1 |
| redb serial (today) | hot | 4 | 79 / 79 / 79 | 13.5 | 707 | – | 1 |
| redb serial (today) | hot | 16 | 79 / 78 / 79 | 13.6 | 1703 | – | 1 |
| redb serial (today) | hot | 64 | 77 / 75 / 74 | 14.9 | 5358 | – | 1 |
| redb OCC | hot | 1 | 108 / 106 / 103 | 9.4 | 13 | 0 | 1.0 |
| redb OCC | hot | 4 | 116 / 111 / 110 | 27.2 | 150 | 2.91 | 1.0 |
| redb OCC | hot | 16 | 104 / 106 / 109 | 134.6 | 427 | 3.00 | 1.0 |
| redb OCC | hot | 64 | 106 / 100 / 100 | 550.6 | 1646 | 3.00 | 1.0 |
| fjall serial | hot | 1 | 81 / 80 / 80 | 12.4 | 15 | – | 1 |
| fjall serial | hot | 4 | 82 / 87 / 86 | 12.7 | 676 | – | 1 |
| fjall serial | hot | 16 | 82 / 83 / 85 | 30.4 | 1679 | – | 1 |
| fjall serial | hot | 64 | 84 / 84 / 83 | 265.3 | 4518 | – | 1 |
| fjall OCC | hot | 1 | 104 / 106 / 106 | 9.5 | 12 | 0 | 1.0 |
| fjall OCC | hot | 4 | 109 / 104 / 106 | 29.6 | 145 | 2.89 | 1.0 |
| fjall OCC | hot | 16 | 107 / 105 / 106 | 137.4 | 390 | 3.00 | 1.0 |
| fjall OCC | hot | 64 | 104 / 106 / 106 | 535.2 | 1611 | 3.00 | 1.0 |

Owner tier (the owner bench from `e58b0795e8`, 1000 ops per client, three runs, every run wrote all
its pages and found them again, 0 errors). All three columns are this branch at `0a7a3b17c5`
plus the fjall change; "today" is the flag off on redb. p50 / p99 are the mean of the three runs:

| Clients | Today ops/s | p50 / p99 ms | redb OCC ops/s | p50 / p99 ms | fjall OCC ops/s | p50 / p99 ms | fjall / today | fjall / redb OCC |
|---|---|---|---|---|---|---|---|---|
| 1 | 883 / 880 / 890 | 1.0 / 4 | 786 / 828 / 777 | 1.1 / 5 | 487 / 498 / 485 | 1.4 / 5 | 0.55x | 0.61x |
| 4 | 606 / 618 / 613 | 2.1 / 19 | 971 / 918 / 997 | 1.6 / 13 | 1327 / 1313 / 1326 | 2.2 / 7 | 2.16x | 1.37x |
| 16 | 504 / 500 / 496 | 28.5 / 117 | 776 / 772 / 732 | 21.5 / 44 | 1304 / 1315 / 1302 | 12.2 / 22 | 2.61x | 1.72x |
| 64 | 390 / 419 / 419 | 159.3 / 266 | 597 / 630 / 590 | 109.0 / 161 | 1350 / 1350 / 1351 | 47.3 / 74 | 3.30x | 2.23x |

What the bake-off says:

1. **fjall stays well ahead under the full design when writers touch different pages.** At 64
   disjoint writers the store does 7.4x redb OCC (1629 against 219 ops/s) with p99 80 ms against
   500 ms, and the owner protocol does 2.2x (1350 against 606 ops/s) with p99 74 ms against
   161 ms. Group commit packs the same number of transactions into one fsync on both stores
   (about 58-60 at 64 writers); fjall's batch is cheaper because it appends to a journal instead
   of copying B-tree pages.
2. **On one hot page the stores tie** (about 105 ops/s, p99 about 1.6 s at 64 writers). A hot
   page commits one writer at a time on any store, so the commit cost is not the limit there.
3. **fjall loses at one client through the owner protocol** (about 490 against 880 ops/s). With
   `strace` on one 1-client run each: both stores sync once per write (517 syncs on redb, 535 on
   fjall), but fjall calls `fsync` on its growing journal (2.92 ms mean) where redb calls
   `fdatasync` (1.65 ms mean). In the store tier, where one op is 3 larger commits, fjall is
   faster at one writer too (119 against 64 ops/s), so the loss is the per-commit sync, not the
   data path. `PersistMode::SyncData` would likely close it; it changes the durability call, so
   it needs the crash simulation on fjall first. Not tried.
4. **The today column moved, and the cause is the page projection queue.** This branch's
   "today" is 883 / 612 / 500 / 409 ops/s; the first write-up measured 910 / 762 / 602 / 520 on
   `e58b0795e8`. See "Why the today column moved" below.

### Why the today column moved

The drift is a feature cost, not machine drift and not the concurrency work.

- **Not the machine.** `e58b0795e8`, rebuilt and run again in the same window as this branch,
  gave 945 / 730 / 593 / 510 ops/s (flag off, three runs), the same as the first write-up.
- **Not the TypeScript.** `e58b0795e8`'s TypeScript with this branch's Rust addon is as slow as
  this branch (934 / 608 / 497 / 418 ops/s), so the cause is in `rust/crates`.
- **The commit.** Each Rust addon along this branch's history, benched with `e58b0795e8`'s
  TypeScript (two runs at 4 and 64 clients, means in ops/s):

  | Rust at | 4 clients | 64 clients |
  |---|---|---|
  | `099e189c29` | 746 | 515 |
  | `ca41d30f0f` | 747 | 510 |
  | `2ffbc3adf4` | 741 | 522 |
  | `41a5cec528` | 614 | 410 |
  | `1321bcb1f2` | 611 | 402 |
  | `7470c703ed` (before any concurrency commit) | 613 | 414 |

  The step is `41a5cec528`, the merge of `rust-engine/projection-queue`. Its one Rust change,
  `041f67abe0` ("Rust brains keep the page projection queue"), turns `queue_page_projection`
  from a stub into real work on every page write: it reads the source record, then writes (or
  deletes) one `page_projection_jobs` row with its job record in the same commit. That is the
  embedded form of the Postgres `gbrain_queue_page_projection` trigger. The bench never drains the
  queue, so the rows grow, and on redb each commit also copies the B-tree pages of a second key
  range.
- **The ablation.** This branch's head with `queue_page_projection` returning at once (a local
  edit, never committed), against the same build with the queue on, two runs each:

  | Clients | Queue on ops/s | Queue off ops/s |
  |---|---|---|
  | 1 | 881 / 840 | 948 / 936 |
  | 4 | 614 / 613 | 766 / 733 |
  | 16 | 496 / 497 | 577 / 615 |
  | 64 | 420 / 385 | 509 / 513 |

  With the queue off the numbers return to the first write-up's. The queue is required for
  Postgres parity, so the cost belongs to the `rust-engine/projection-queue` lane: batching or
  coalescing the queue row (for example, skipping the write when the job row already holds the
  same reason) might win much of it back; I did not try it. The concurrency comparisons above all use the same
  base on both sides, so their ratios stand.

### Crash research on fjall

fjall does its own file I/O, so the simulated disk (`SimDisk` with a `FaultPlan`) cannot stand
under it: torn writes, dropped caches and failed fsyncs cannot be injected. In their place,
`tests/occ_history.rs` has a `fjall_research` module (built only with the `fjall` feature):

- **History check.** The same writers and checker as the redb run, on fjall: 4, 16 and 64
  writers, three seeds each, then a clean close and reopen. Every acknowledged history replays as
  one serial order, and the state survives the reopen. Pass.
- **Process kill.** A child process runs 4, 16 or 64 writers on a fjall store without end. Each
  writer prints its attempt before a commit and the commit sequence after it. The parent sends
  `SIGKILL` after 0.3-1 s, reopens the store and checks: every acknowledged commit is present;
  every transaction in the store was attempted; each transaction is whole (both of its registers,
  or its row); the counter equals the number of transactions; the row values are 0, 1, 2, ...
  with no gap; the register orders have no cycle; the commit sequence is not behind an
  acknowledged one; and the first id handed out after the reopen is above every recovered one.
  20 runs per writer count, all pass:

  | Writers | Acknowledged before the kill | Found after reopen | Committed, not yet acknowledged |
  |---|---|---|---|
  | 4 | 4912 | 4945 | 33 |
  | 16 | 6633 | 6669 | 36 |
  | 64 | 7258 | 7304 | 46 |

  A third test feeds the checker a torn transaction and a lost commit, and it refuses both.

What this does not show: `SIGKILL` leaves the operating system's page cache in place, so this is
a process crash, not a power loss or a failed fsync. A power-loss check on fjall needs a VM or a
block device that drops unsynced writes (for example `dm-log-writes` or a `dm-flakey` device),
which I did not set up. Run the kill test longer with `GBRAIN_FJALL_KILL_RUNS=<n> cargo test -p
gbrain-store --features fjall --test occ_history fjall_research`.

## Caveats and losses

- **One machine, one disk.** fsync here is about 3 ms. On a laptop NVMe disk fsync is often
  under 1 ms, which raises every serialized number and shrinks the group-commit gain; on slower
  disks the gain grows. Each point of the first write-up is one or two runs, not a distribution;
  the fjall bake-off is three runs per point.
- **One writer is not faster.** At 1 writer the prototype is within noise of today (owner tier
  0.98x; store tier 66 against 70 ops/s disjoint). Its gain starts at 4 writers.
- **A hot page is still one writer at a time.** That is the Postgres result too, and it is what
  "Postgres-equal output" requires; the prototype only makes the line fair.
- **File format (fixed on concurrency-proto-2).** The new counters live under new keys.
  `FORMAT_VERSION` is now 2: a format-1 brain is upgraded to the new counter keys when it opens,
  and a binary that knows only format 1 refuses a format-2 brain instead of reading stale counts
  (`tests/lifecycle.rs`).
- **Order of journal ids.** Journal sequence numbers are handed out at allocation, not at commit,
  so across disjoint writers they are not in commit order (the same as a Postgres `bigserial`).
  Version ids per page stay monotonic. Reruns leave gaps in ids.
- **Job queue (built on concurrency-proto-2).** Job claims stay exactly-once with concurrent
  writes on: `tests/jobs.rs` races 4, 16 and 64 workers over 128 jobs, and the engine-parity
  `jobs.test.ts` runs an 8-worker case against PGLite and Postgres. Flag-on conflicts (325 / 505 /
  593 at 4 / 16 / 64 workers) are all on the claim-index head keys, which is inherent to one
  ordered queue. Not built: wake subscriptions (`LISTEN/NOTIFY`).
- **Vectors were not in the write.** `upsert_chunks` does not store embeddings, so the benchmark
  has no vector cost.
- **The owner tier mixes in things the store does not control** (IPC, the 32-permit pool, Bun
  processes on 8 cores). I did not profile why the prototype's gain there falls from 1.8x at 4
  clients to 1.6x at 64.
- **History check (built on concurrency-proto-2), redb only.** `tests/occ_history.rs` runs 4, 16
  and 64 writers, records every transaction's reads and writes, and checks that the acknowledged
  commits have a serial order, also across simulated crashes and failed fsyncs (every acknowledged
  commit survives; the batch in flight is applied whole or not at all). Two mutations of the
  conflict check make it fail. The thread interleaving is real, not deterministic, so a run finds
  bugs but does not prove their absence. The crash and fsync faults are injected through a redb
  fault backend; fjall has had no crash simulation.
- **A future change, not done**: `raise_latest` in `timeline.rs` reads and rewrites a "latest"
  marker; it could become an `Op::Max`-style raise so it never conflicts.

## Recommendation

Adopt the prototype's design for the Rust store: optimistic transactions with one ordered
group-commit pipeline, typed non-conflicting ops for ids, counters and admission caps, and
queue-on-conflict for hot keys. It is the only option measured that raises throughput with more
writers (6.3x at 64 disjoint writers in the store, 1.6-1.8x through the owner protocol). It cuts
store p99 at 64 writers from 6.4 s to 0.45 s for disjoint pages and from 5.4 s to 1.5 s for one
hot page (1.6x lower through the owner protocol). It returns no busy error, and keeps every result equal to a serial (Postgres) order.
Do not shard. The format bump, the history checker and the job queue are now built (see
"Caveats and losses"); the design stays behind `GBRAIN_RUST_CONCURRENT_WRITES`, default off.

For the base store: move to fjall after the Dec 1 parity work, behind the same opt-in and not as
the default, if it still leads under the full design. Before the move: run `tests/occ_history.rs`
crash and fsync simulation on fjall, make the 2 redb-named lifecycle tests store-neutral, decide
the redb-to-fjall migration for existing brains, and measure `PersistMode::SyncData` against the
1-client loss.

## Reproduce

```bash
cd rust/concurrency-bench
cargo build --release --features raw
./target/release/store-bench --secs 5                # today: one writer at a time
./target/release/store-bench --concurrent --secs 5   # concurrent_writes on
./target/release/rawkv-bench --secs 3

# fjall bake-off (store tier):
cargo build --release --features fjall
./target/release/store-bench --fjall --secs 5                # fjall, one writer at a time
./target/release/store-bench --fjall --concurrent --secs 5   # fjall under OCC
# store tests on fjall (from rust/):
GBRAIN_RUST_BAKEOFF_STORE=fjall cargo test -p gbrain-store --features fjall

# fjall bake-off (owner tier): this branch does not carry the owner bench. OWNER_CHECKOUT is a
# worktree of this branch with the bench script and its two test helpers (rust-owner-bench.ts,
# rust-owner-child.ts) copied in from e58b0795e8. In its rust/:
cargo build --release -p gbrain-napi --features gbrain-store/fjall
GBRAIN_RUST_ENGINE_ADDON=<that libgbrain_napi.so> GBRAIN_RUST_CONCURRENT_WRITES=1 \
  GBRAIN_RUST_BAKEOFF_STORE=fjall bun "$OWNER_CHECKOUT"/scripts/bench-rust-owner.ts --clients 16 --ops 1000

# Owner tier, first write-up: OWNER_CHECKOUT is a checkout of rust-engine/owner-protocol
# (e58b0795e8), run once as it is and once with this branch's rust/crates copied in:
bun install && bun run rust:build
GBRAIN_RUST_ENGINE_ADDON=$PWD/rust/target/addon/gbrain_engine.linux-x64-glibc.node \
  bun "$OWNER_CHECKOUT"/scripts/bench-rust-owner.ts --clients 16 --ops 1000
```
