# Multi-user prior art for the Rust engine

Research record, 2026-11-16 (America/Los_Angeles). Read-only research: no code changed.
This page answers two questions from the maintainer for the Rust engine plan
(`docs/designs/RUST_ENGINE.md`, PR #9593):

1. There is a Rust reimplementation of Postgres. What can gbrain take from it for multi-user use?
2. What are the most bulletproof multi-user implementations for gbrain's workload?

The bar comes from the plan's decisions:

- **D17**: equal or better than TypeScript gbrain on Postgres and on PGLite on every axis; the target is 10x.
- **D18**: no SQL dialect. Typed `BrainEngine` methods only; raw SQL is refused with `engine_capability_missing`.
- **D19**: single machine first, a server-ready core, and a multi-user Rust server as the end state (phases M1 to M5).
- **D20**: no PGLite-style locking. The maintainer's words: "pglite sucks! there are so many locks and problems
  with it. the rust implementation we want it to be pristine and perfect for our cases." No process-wide lock,
  no busy error, no file lock that makes a second process fail or wait for the whole brain.

Each candidate gets one verdict: **adopt** (use it as a library), **copy** (copy the design, write our own code)
or **avoid**. Facts were checked against primary sources (repositories, docs, release notes, papers, Jepsen
reports) on 2026-11-16. A vendor's own blog counts as a source only for that vendor's own claims, and is
labelled so. Some star counts and release dates could not be read because the GitHub API rate limit was
reached; those cells say "not checked".

## TL;DR

Top 10 findings:

1. **pgrust is a faithful Rust port of Postgres, locks included.** It ports Postgres's lock manager, `SKIP LOCKED`, advisory locks and WAL. It is AGPL-3.0, beta, and its README says not to run it in production. It speaks SQL, so D18 rules it out. Avoid it as a dependency; it would bring back the lock model D20 removes.
2. **No embedded Rust store gives everything at once.** None has many writers, no busy errors, snapshot readers, proven crash safety, multi-process access and a follower log together. gbrain has to own its transaction layer and put it on top of a small, proven store.
3. **FoundationDB is the design to copy.** Clients take no locks. At commit, a resolver checks each transaction's read ranges against newer writes. The result is strict serializability, and nightly deterministic simulation stands behind it. Copy optimistic transactions with conflict ranges, and copy simulation testing from the first PR.
4. **redb is the strongest storage base for the bake-off.** It is stable, its file format is stable, it has checksummed dual commit slots (a one-phase commit with a checksum and one fsync by default, two-phase as an option), and its fuzzing injects I/O errors. Its single writer is fine underneath an optimistic layer: callers never hold the redb writer; one ordered commit pipeline validates write sets and applies them in batches.
5. **Turso's `BEGIN CONCURRENT` is the closest Rust multi-writer engine, but it is not ready.** It gives snapshot isolation, not serializability. A conflict returns `SQLITE_BUSY`. MVCC mode has no multi-process access, and correctness issues are still open. Watch it; do not adopt it.
6. **Snapshot isolation is not enough for gbrain.** Quotas, caps and single claims break under write skew. Jepsen found anomalies in PostgreSQL 12.3 at `SERIALIZABLE` and lost updates in TiDB 2.1.7. Use serializable validation, or make each invariant a write to one conflict key.
7. **Every lock and queue call site has a counterpart in a proven system without PGLite-style whole-brain locking.** `SKIP LOCKED` claims become claim operations on a ready index with fencing tokens. TTL leases become epoch-fenced leases (SlateDB, FoundationDB). Advisory locks become conflict keys. `LISTEN/NOTIFY` becomes a commit-log subscription (Convex).
8. **RLS becomes a typed scope capability plus physical partitioning.** Only the authentication boundary can build the scope object, and every method takes it. Indexes are partitioned per source or tenant, and BM25 statistics are kept per tenant. Cedar (Rust, Apache-2.0, proofs in Lean) can make the policy decision. A SpiceDB-style token gives read-your-writes. Avoid Oso (archived) and OpenFGA (no consistency token).
9. **Search indexes need their own concurrency rules.** tantivy allows one writer per index, so one engine task must own it. Concurrent HNSW insert and search is unsafe by default (usearch #735, a YugabyteDB fix). Use an immutable base, a delta that readers never see half-built, and tombstones, and pin every index to the same version as the records (Lance manifests, ParadeDB's MVCC directory).
10. **Replication can wait, but the format cannot.** Write a commit log now so a follower can read it later. openraft is the best Rust Raft library for M3/M4; avoid raft-rs (its last release was 2023, with open safety issues). Copy Neon's PITR design: a restore point is a log position, not a copy.

**We learned that the bulletproof systems avoid whole-brain locks; they validate at one ordered commit step and test in simulation.
You should build gbrain's own optimistic, serializable transaction layer (FoundationDB's design) over a
proven embedded store (redb is the front-runner), with deterministic simulation from day one.**

## Recommendation

1. **Concurrency control.** Build optimistic serializable transactions in `gbrain-store`, following
   FoundationDB's design. A transaction reads at a snapshot version and records the keys and key ranges it
   read and wrote. A transaction with no conflict commits; a transaction with a conflict gets a typed
   `conflict` result. The engine re-runs it from a new snapshot inside the typed operation, with a bounded
   budget and backoff, so callers never see a busy error (D20). It never re-applies the old writes. Writers
   never wait for other writers' locks. Readers never wait at all.
2. **One ordered commit pipeline, not a writer lock.** Validation and commit order happen in the same place:
   one commit pipeline per brain. The pipeline takes transactions one at a time in commit order. It checks
   each read set against every write committed after that transaction's snapshot and against every write
   already accepted into the current batch. It then gives the transaction its commit version. Without that
   second check, two transactions could both pass and overwrite each other inside one batch. The pipeline
   writes each batch as one store transaction (group commit), makes it durable, and only then acknowledges
   and publishes the new version to readers. No caller holds the pipeline while it does its own work. It
   plays the role the WAL insert plays in every database. The Phase 2 bake-off measures its p99 under 64
   writers, as D20 requires. If it becomes the bottleneck, shard it by source.
3. **Hot keys.** For a key that many writers contend on (a quota counter, a queue head), an optimistic retry
   loop wastes work. Use typed operations that cannot conflict on that key: atomic add, compare-and-set, or
   per-key single flight inside the owner process. This matches the plan's D20 table.
4. **Store.** Bake off redb against Fjall's `OptimisticTxDatabase` and LMDB through heed as the record store.
   Measure the optimistic layer above each one. Keep one owner process per brain with client handoff (the
   plan's PR 18). Do not let several processes open the store files directly, because that brings file locks
   back.
5. **Proof.** Before the store is chosen, build a deterministic simulation harness (turmoil for I/O and
   crashes, shuttle or loom for thread interleavings) and an Elle-style history checker for serializability.
   Every typed operation in the D20 table gets a simulation property. Antithesis is a paid option: the
   maintainer decides.
6. **Replication and backup later, format now.** The commit log must carry everything a follower needs, so
   an openraft log can sit under it in M3/M4. Point-in-time restore is "open the store at log position N".

## Comparison table

How to read the ratings: **strong** means proven in production or by an outside test; **ok** means present
but unproven or limited; **weak** means missing or known to be broken; **not checked** means no primary
source was read for that cell; **n/a** means the axis does not apply.
"Proven correctness" means an outside check (Jepsen, deterministic simulation, formal proofs), not the
project's own unit tests.

| Candidate | Concurrency control | Crash safety | Replication | Access control | Backup / PITR | Multi-process, one machine | Proven correctness | Verdict |
|---|---|---|---|---|---|---|---|---|
| pgrust | Postgres MVCC + lock manager (row locks, SSI) | ok: WAL, crash simulator, fsync change not yet tested | ok: ported walsender | ok: RLS ported | ok: ported | strong: server | weak: own claims, no Jepsen, beta | avoid (copy 2 ideas) |
| Turso (MVCC) | SI, row-level optimistic, `SQLITE_BUSY` on conflict | ok | weak: CDC only | weak | weak | weak: none in MVCC mode | ok: DST, Antithesis, no Jepsen | copy, watch |
| SQLite | single writer, WAL | strong | weak | weak | ok | strong: WAL + shm | strong: TH3, 100% MC/DC | copy test discipline |
| redb | single writer, MVCC readers, serializable | strong: checksummed dual slots; 1-phase + checksum by default, 2-phase optional | weak | n/a | weak: savepoints | ok: file range locks | ok: fuzzing with I/O-error injection | adopt as base (bake-off) |
| Fjall | OCC multi-writer, serializable | ok | weak | n/a | weak | weak: forbidden | weak | adopt candidate (bake-off) |
| LMDB / heed | single writer, lock-free readers | strong | weak | n/a | ok: hot copy | strong | ok: long production use | adopt candidate (bake-off fallback); copy lock-free readers |
| RocksDB | pessimistic or optimistic transactions | strong | weak: secondary instances | n/a | ok: checkpoints | weak: one writer process | ok: heavy production use | copy (C++ weight) |
| FoundationDB | OCC, conflict ranges, strict serializable | strong | strong | n/a | not checked: a continuous backup agent exists | strong: cluster | strong: nightly DST, paper | copy (design to follow) |
| TiKV | Percolator, optimistic + pessimistic, SI | strong | strong: multi-Raft | n/a | not checked: external BR tool | strong: cluster | ok: Jepsen found lost updates (2019, fixed) | copy |
| CockroachDB | serializable, HLC, parallel commits | strong | strong | ok: roles and privileges | ok: BACKUP/RESTORE with PITR (license tier not checked) | strong | ok: Jepsen 2017, TLA+ | avoid (license), copy TLA+ |
| TigerBeetle | single-threaded state machine, strict serializable | strong | strong: VSR | n/a | not checked | strong | strong: Jepsen 2025, VOPR DST | copy test discipline |
| openraft | Raft log | n/a | strong: production use | n/a | ok: snapshots | n/a | ok: own DST + Jepsen-style suite | adopt for M3/M4 |
| SlateDB | single writer with epoch fencing | ok | ok: object store | n/a | not checked | ok: one writer, many readers | ok: project says fencing is formally verified | copy fencing |
| Neon | Postgres + Paxos WAL quorum | strong | strong | n/a (Postgres) | strong: LSN branches | strong | ok | copy PITR design |
| Convex | OCC with read sets, reactive queries | not checked | weak: self-host is one machine | ok: functions | not checked | strong: server | weak: no outside test | copy subscriptions |
| Lance | OCC manifests, per-operation conflict rules | ok | weak | weak | strong: version travel | ok | weak | copy manifest design |
| tantivy | one writer per index, snapshot readers | strong: atomic `meta.json` | weak | weak | weak | weak: one writer process | ok: production use | adopt for full-text search |
| Qdrant | per-point last write wins | weak: crash bugs into 2026 | ok | ok: per-collection keys | weak: per node | n/a | weak | avoid (copy 2 ideas) |
| Cedar | n/a (stateless) | n/a | n/a | strong | n/a | n/a | strong: Lean proofs, differential tests | adopt for policy |
| SpiceDB | snapshot reads at a revision | n/a | n/a | strong | n/a | n/a | not checked: no Jepsen found | copy consistency token |

How the axes rank the designs, best first, for gbrain's case:

- **Concurrency control:** FoundationDB (optimistic, conflict ranges, strict serializable) > CockroachDB
  (serializable) > TigerBeetle (one thread, ordered batches) > TiKV (snapshot isolation plus pessimistic
  locks) > Turso MVCC (snapshot isolation, busy errors) > single-writer stores (redb, LMDB, SQLite).
- **Crash safety:** SQLite and LMDB (decades of use) > redb (checksummed dual commit slots, fuzzing with injected I/O
  errors) > tantivy (atomic `meta.json`) > Lance, Turso > Qdrant (crash bugs into 2026).
- **Replication:** FoundationDB, TiKV, CockroachDB, TigerBeetle (built in, tested) > openraft (a library,
  used in production) > Neon (Paxos WAL quorum) > raft-rs (stalled) > embedded stores (none).
- **Access control (RLS replacement):** Cedar (policy proofs) + typed scope > SpiceDB (consistency token) >
  Postgres RLS (pitfalls listed below) > OpenFGA (stale checks) > Oso (archived).
- **Backup / PITR:** Neon (restore point = log position) > Lance (version travel) > per-node snapshots (Qdrant). FoundationDB,
  TiKV and TigerBeetle backup were not checked, so they are not ranked.
- **Multi-process on one machine:** a server or owner process (FoundationDB, pgrust, gbrain's owner) > LMDB
  and SQLite WAL (shared memory) > redb (file range locks) > Fjall and Turso MVCC (not supported).
- **Proven correctness:** TigerBeetle (Jepsen plus simulation) and FoundationDB (nightly simulation) > SQLite
  (MC/DC) > Cedar (Lean proofs, but only for the policy engine) > CockroachDB, TiKV (Jepsen, fixed) >
  Turso, openraft (simulation, self-reported) > pgrust (regression suite, vendor claims).

## Per-candidate notes

Each entry: what it is, the facts that matter for gbrain, and the verdict with the reason. "Copy" always
means: read the design, write our own code. Code under AGPL is never copied, only read.

### The Rust Postgres: pgrust

- **What it is.** A Rust rewrite of Postgres (pgrust.com; source links under Sources). Wire-compatible
  with PostgreSQL 18, with the same SQL dialect, error codes and message text. License AGPL-3.0; no
  commercial license was found. Releases: v0.3 (2026-09-15), v0.3.1 (2026-10-19), v0.4-beta (2026-10-22,
  with a new query engine and columnar MVCC writes). About 5,800 stars. The repository does not accept pull
  requests.
- **Concurrency.** A faithful port of the C code: heap MVCC with `xmin`/`xmax`, the heavyweight and
  predicate lock managers (SSI), deadlock detection, `SKIP LOCKED` and the advisory-lock functions. The
  undo log with no vacuum, and instant forks, are roadmap or prototype items, not shipped code. It runs as
  one process with a thread per connection. There is no embedded or library mode; that is on the roadmap.
- **Durability.** WAL ported from Postgres. One change from Postgres: a worker releases its locks after it
  calls fsync but before fsync completes. The project says this is safe because nothing is acknowledged
  until fsync finishes. No crash-test result for this change is published. An earlier race lost some writes
  on disk; the project found and fixed it.
- **Correctness evidence (vendor claims).** It passes 100% of the PostgreSQL 18.3 regression and isolation
  tests (46,066 tests, 2026-06-25). On a corpus of 164,000 cases from drivers, ORMs and apps, divergences
  from Postgres fell from 1,454 to 11 (v0.3). Kani proofs show 1,397 of 3,400 user-facing built-in
  functions behave the same as the C code; these are proofs of single functions, not of the engine. It has a
  crash simulator with 12 profiles and an Antithesis engagement, with no public report. No Jepsen analysis
  exists. The code was written mostly by coding agents, and the project keeps no record of which code an
  agent or a person wrote (issue #39). Its benchmark claims are about analytics (ClickBench) and were
  disputed on Hacker News.
- **Verdict: avoid as a dependency; copy two ideas.** AGPL would force gbrain's license, the README says it
  is not for production yet, and it speaks SQL (D18). The deciding reason is D20: pgrust keeps the Postgres
  lock model, the model gbrain is leaving. It does not carry the move away from locks. Ideas to copy, from
  its design notes (D17): one memory budget for the whole process that covers buffers, caches and running
  queries, and cancels the statement that holds the most memory; and a scheduler that lowers the priority of
  long-running queries so short ones stay fast.

### Other Rust or Rust-adjacent Postgres projects

- **Turso's Postgres frontend** (MIT, announced July 2026, experimental). It is a second SQL frontend on
  Turso's SQLite-compatible core, not a Postgres server rewrite. Verdict: avoid; it is SQL (D18) and
  experimental. Its storage core is covered under Turso below.
- **Small rewrites** (for example rupg, Apache-2.0, created 2026-10-07, 4 stars). Verdict: avoid; too new
  to judge.
- **pgrx** (MIT, 0.20.0, active): the framework for writing Postgres extensions in Rust. Verdict: adopt only
  if gbrain ships a Postgres extension for its Postgres engine. It does not apply to the Rust engine. pgrust
  has no stable extension ABI, so pgrx extensions do not run on it.
- **pgvecto.rs**: deprecated in favor of VectorChord. Verdict: avoid.
- **VectorChord** (AGPL-3.0 or ELv2): RaBitQ quantization with an IVF index (`vchordrq`) and a graph index
  (`vchordg`). Verdict: copy the RaBitQ and IVF design for the Phase 2 ANN bake-off if HNSW memory is the
  limit (D17 memory axis); do not adopt.
- **ParadeDB pg_search** (AGPL-3.0): stores tantivy segments in Postgres block storage, tags each segment
  with the transaction that made it visible, lets only one merge run at a time (gated by transaction ID),
  and writes everything to the WAL. A VACUUM bug in segment cleanup was fixed (PR #2142). Verdict: copy the
  design. A search index whose segments are filtered by the reader's snapshot gives full-text results
  "as of" the same version as the records.
- **Neon** (Apache-2.0, now Lakebase): a Postgres fork with Rust storage. WAL goes to a Paxos quorum of
  safekeepers. A page server rebuilds any page at any log position (LSN). A branch or a point-in-time
  restore is a metadata pointer at an LSN, not a data copy. Verdict: copy this design for M4 backup, PITR
  and per-user branches. Do not adopt it; it needs a Postgres fork.
- **Connection poolers** (PgBouncer ISC, PgCat MIT, PgDog AGPL, Supavisor Apache-2.0). In transaction mode
  they drop session state: session advisory locks, `SET`, and `LISTEN` break, and transaction-scoped locks
  survive. gbrain already works around this: `db-lock.ts` keeps its long locks as TTL rows in
  `gbrain_cycle_locks` instead of session advisory locks, and other sites use transaction-scoped
  advisory locks. PgBouncer 1.26.1 (2026-10-14) fixed three CVEs, one a SCRAM authentication bypass.
  Verdict: copy the lesson only; nothing to adopt for the Rust engine. The lesson for the M1 server: connection state must belong to the engine's connection object, not
  to a pooled socket, and change notification needs its own channel (PgDog builds its own pub/sub for this).

### Embedded stores (the bake-off pool)

- **Turso (SQLite rewrite in Rust, MVCC mode).** MIT, v0.8.3 (2026-10-12), about 25,000 stars; the beta
  label was dropped in 0.7, but it is not 1.0. `BEGIN CONCURRENT` gives row-level optimistic writers with
  commit-time conflict checks in the style of Hekaton, at snapshot isolation. A write-write conflict returns
  `SQLITE_BUSY`, and the caller must retry. MVCC mode has no multi-process access. The multi-process WAL is
  an experimental flag, not ready for production. Open issues: #5955 (foreign keys across concurrent
  transactions) and #6335 (an MVCC delete). It has a concurrent simulator, Antithesis runs and a DBTest '26
  paper on its random testing; no Jepsen analysis. It has CDC (a change table per connection). Verdict: copy
  the commit-time row conflict check and the CDC shape; watch for 1.0. Do not adopt now: SQL (D18), busy
  errors (D20), no multi-process access in MVCC mode, and snapshot isolation only.
- **SQLite.** One writer; WAL plus a shared-memory index for many processes. `BEGIN CONCURRENT` exists only
  on a branch, and its commit is still serialized. Verdict: copy its testing discipline: TH3 with 100%
  MC/DC branch coverage, crash and I/O-error injection, and fuzzing. This is the proof bar for the store
  layer. Avoid it as the engine; bundled SQLite as a key-value store stays a Phase 2 option, but the plan's
  D18 rules out its SQL.
- **redb.** Apache-2.0, v4.6.0 (2026-11-13), about 4,900 stars, marked stable, stable file format. One
  writer at a time; readers use MVCC snapshots and never block; transactions are serializable. Crash design:
  two commit slots with XXH3-128 checksums, so recovery picks the last valid slot and never replays a log.
  The default durable commit is one-phase with a checksum and a single fsync; two-phase commit is optional
  in one process and required in multi-process mode. The design notes advise two-phase commit for
  untrusted input, because XXH3 is not a cryptographic checksum. The bake-off measures both modes. It has a fuzz crate with I/O-error injection. It supports several processes, with one
  or several writer processes, through file range locks, and documents which features multi-process mode
  does not support. Verdict: adopt as the leading base store for the Phase 2 bake-off, under gbrain's own
  optimistic layer. Its single writer is acceptable only because callers never hold it: the commit step
  holds it for one batch. Do not use its multi-process mode; that is a file lock (D20).
- **Fjall.** Apache-2.0, v3.1.13 (2026-10-25). An LSM store with `OptimisticTxDatabase` (many writers,
  serializable, optimistic) and `SingleWriterTxDatabase`. Its README forbids opening one database from
  several processes. Verdict: adopt candidate, conditional on the Phase 2 bake-off, as a base store under the
  owner process, which needs only one process. Copy the idea of choosing single-writer or optimistic mode per database. It has less
  crash-test evidence than redb.
- **LMDB through heed.** heed is MIT, v0.23.1. One writer; readers take no locks; many processes share the
  memory map. Stale readers must be cleared (`mdb_reader_check`). heed issue #20 shows a deadlock pattern to
  avoid. Verdict: adopt candidate, conditional on the bake-off (fallback). Copy its lock-free reader design.
- **RocksDB (rust-rocksdb v0.25.0).** Pessimistic transactions (a lock manager) and optimistic transactions.
  Other processes can open it only read-only or as a "secondary". It is a large C++ dependency. Verdict:
  copy; adopt only if the bake-off shows a write-throughput need nothing else meets (D17).
- **SurrealKV.** Apache-2.0, v1.4.0 (1.0 on 2026-10-13). Snapshot isolation with an optimistic commit
  ring, and versioned reads (`get_at`). Default durability is `Eventual`, so an acknowledged write can be
  lost. Issue #376 (a race in first-committer-wins) is open. Verdict: copy versioned reads; avoid as a store.
- **CanopyDB** (MIT, 0.2.5): SSI and SI with optimistic commits, in one process. Verdict: copy as a small
  reference for SSI on a B-tree; too young to adopt.
- **sled** (last release v0.34.7 in 2021, rewrite in progress). Verdict: avoid.
- **GlueSQL** (SQL engine in Rust). Verdict: avoid under D18.
- **SurrealDB** (v4.0.1, license not stated in SPDX form). Its `PERMISSIONS` clause with `$auth` is a
  row-level policy in the query language. Issue #7472 showed that its local engines dropped transaction
  conflicts (closed 2026-11-05). Verdict: copy the idea of policies attached to each table and checked by
  the engine; avoid the product and the language (D18).

### Distributed designs (for D19 and phases M3/M4)

- **FoundationDB.** Apache-2.0, about 16,900 stars. Clients never lock. A transaction reads at a version
  and sends its read and write conflict ranges with the commit. Resolvers check the read ranges against
  writes in the recent version history and abort a transaction that read stale data. The result is strict
  serializability. Roles (sequencer, proxies, resolvers, log servers, storage servers) are separate. The
  team runs tens of thousands of deterministic simulations each night with injected faults (SIGMOD 2021
  paper). There is no Jepsen analysis on jepsen.io. Verdict: copy this design first; it is the model for
  gbrain's transaction layer. Take three things: conflict ranges checked at commit, no locks held by
  clients, and simulation testing from the first line of code. Do not adopt the server; it is a cluster
  product with its own operations.
- **TiKV.** Apache-2.0, about 17,000 stars. Percolator transactions: a `lock` column family holds
  uncommitted locks and a `write` column family holds commit records. Optimistic and pessimistic modes
  (`for_update_ts`), async commit and one-phase commit, multi-Raft. Snapshot isolation by default. Jepsen
  (TiDB 2.1.7, 2019) found that automatic retries re-applied writes and caused lost updates and read skew;
  with retries off, snapshot isolation held. Verdict: copy the Percolator layout only if gbrain needs
  pessimistic locks across hosts in M3. Copy the warning too: an automatic retry must re-run the whole
  transaction against a new snapshot, never re-apply old writes.
- **CockroachDB.** Go, CockroachDB Software License since 24.3. Serializable by default, hybrid logical
  clocks, parallel commits with a TLA+ specification. Jepsen tested a 2016 beta; the bugs found were fixed.
  Verdict: avoid as a dependency (license); copy the TLA+ practice for the commit protocol. gbrain already
  has TLA+ properties in `spec/tla/` that the plan keeps as tests.
- **TigerBeetle.** Zig, Apache-2.0. One thread applies ordered batches, so there is no lock contention by
  design; VSR replication. Jepsen (0.16.11, 2025-06-06) found 2 safety issues and 7 crashes; all were fixed
  by 0.16.45 except indefinite client retries. Jepsen found a bug that four fuzzers had missed. Verdict:
  copy its test discipline (the VOPR simulator plus an outside Jepsen-style test). Its single-threaded
  apply also supports the commit-pipeline idea in the recommendation.
- **openraft.** Apache-2.0, about 2,100 stars, active (pushed 2026-11-17). The latest release is 0.10.0
  (crates.io, 2026-11-10); the API is pre-1.0 and changes between minor versions. Used in
  production by Databend's meta service and others. The project runs turmoil-based simulation in CI and a
  Jepsen-style suite with 8 fault types (self-reported; not on jepsen.io). Verdict: adopt for M3/M4 only,
  under the commit log. Not before then (D19: single machine first).
- **raft-rs.** Last release v0.7.0 (2023-03-07). Open issues include a stale read (#600), a phantom
  acknowledgement (#599) and a panic (#595). Verdict: avoid.
- **SlateDB.** Apache-2.0, about 3,700 stars. An LSM on object storage with one writer and many readers.
  A new writer takes a higher epoch, and the protocol guarantees that no older writer can write to the
  manifest or WAL after that. The project says the fencing protocol is formally verified (method and scope
  not checked). Verdict: copy epoch fencing for gbrain's leases. A TTL alone does not stop a paused old
  holder from writing; an epoch checked at commit does.
- **Convex.** FSL-1.1-Apache-2.0. Optimistic transactions with read sets; a query re-runs when a write
  touches its read set, and clients get pushed updates. Verdict: copy reactive subscriptions as the
  replacement for `LISTEN/NOTIFY`; avoid the product (license, server shape).
- **Databend** (meta service on openraft): copy the idea "keep cluster metadata in a small Raft key-value
  store". **DataFusion**: adopt only for analytics reads behind typed methods, never on the write path.
  **RisingWave, GreptimeDB, Materialize (BSL)**: avoid; they are streaming or analytics systems.
- **Jepsen results to remember.** PostgreSQL 12.3 (2020): a G2-item anomaly at `SERIALIZABLE`. NATS 2.12.1
  (2025-12-08): acknowledgement before fsync lost writes. ParticleDB 1.1.4 (2026-10-31): the default `occ`
  mode lost committed writes. The lesson for gbrain: test the default configuration, acknowledge only after
  the data is durable, and check serializability with a history checker, not with assertions.

### Search indexes under concurrency

- **Lance / LanceDB** (Apache-2.0). Writers write data files, then commit a new immutable manifest with an
  atomic create-if-absent. Each commit records its operation type, and a conflict matrix decides which
  concurrent operations can rebase and retry. Appends never conflict; deletes and updates on overlapping
  fragments do. One manifest version pins data and indexes together. A user reported retry exhaustion on
  concurrent deletes in one table (lancedb #3086, open). Verdict: copy the manifest design (one version for
  records, vectors and full-text search) and the per-operation conflict rules. Do not copy retry loops on
  hot keys; serialize same-source deletes instead.
- **tantivy** (MIT). One `IndexWriter` per index directory, guarded by a lock file that fails fast. A
  second process cannot write (tantivy #2408: shared-memory locking "will most likely not work"). Inside
  one process, `add_document` takes `&self`, so many threads can feed one writer. `meta.json` is replaced
  atomically at commit. For read-your-writes, use `ReloadPolicy::Manual` and reload after commit. Verdict:
  adopt for full-text search, owned by one engine task per index that all writes go through. That task is
  an in-process queue, not a lock that fails (D20).
- **HNSW with concurrent insert and search.** Not safe by default. usearch #735 (open) reports nodes that
  concurrent inserts make unreachable. A YugabyteDB fix (commit ba7507a, 2026-06-18) adds a reader/writer
  phase lock, because a search could read a neighbor link before the vector it points to is visible.
  YugabyteDB's vector LSM, and the third-party `diskann-rs` crate (not Microsoft's DiskANN; a secondary
  source), use an immutable base, a delta and tombstones. Verdict: copy that shape, with one rule the
  usearch race makes necessary: a reader never searches a graph that is still being changed. New vectors
  go to a small flat delta that readers scan by brute force at their snapshot version, or to delta
  segments that are immutable once published. A background build publishes a new graph segment; merges
  publish a new base. No reader waits on an insert, and no reader sees a half-built graph.
- **Qdrant** (Apache-2.0). Per-point last-write-wins; the default favors availability over consistency.
  It had crash-consistency bugs from 2023 into 2026; the latest one, PR #9424 (2026-06-11), fixed filter
  updates lost across a restart. Snapshots are per node, not one point in time for the cluster. Verdict:
  avoid as an engine (a second source of truth, D18). Copy two ideas: group index data by tenant first
  (`is_tenant`), and give large tenants their own shards while small tenants share.
- **turbopuffer** (closed source; vendor documentation only). A namespace per tenant, a synchronous WAL
  append before a write returns, and an asynchronous indexer with backpressure. Data that is not indexed
  yet can be invisible to queries. Verdict: copy the namespace per tenant. gbrain needs read-your-writes,
  so the engine must index synchronously or search the unindexed tail by brute force.

### Access control (the RLS replacement)

- **Cedar** (Rust, Apache-2.0, 4.15 released 2026-11-16). A policy language and evaluator: principal,
  action, resource, context. Policies are checked against a schema. A formal model in Lean has proofs of
  safety properties, and differential random testing checks the Rust code against the model. The sources
  name Lean only; no Dafny work was found. Partial evaluation, which could turn a policy into an index
  filter, is experimental. Verdict: adopt for the policy decision at the capability boundary ("may this
  principal read this source?"). It is not a row filter.
- **SpiceDB** (Go, Apache-2.0). Zanzibar-style relationships. A write returns a token, and a later check
  can ask to be at least as fresh as that token. This solves the "new enemy" problem: a revoked user must
  not see data written after the revocation. Verdict: copy the token idea. gbrain's commit version is
  already that token; pass it from a write to the next read. Do not run SpiceDB itself (a network hop and a
  second store).
- **OpenFGA** (Go, Apache-2.0). There is no consistency token, and a cache can serve stale checks (issue
  #1777). Verdict: avoid.
- **Oso** (Polar). The open-source library is archived and read-only, deprecated since 2023-12-18. Verdict:
  avoid.
- **Biscuit** (Rust, Apache-2.0). Signed tokens that the holder can narrow offline, with Datalog checks.
  Verdict: copy for remote delegation later ("read source X, last 30 days"), turned into the engine's
  typed scope at the server boundary. Do not use tokens as the enforcement point inside the engine.
- **Postgres RLS pitfalls** (from the PostgreSQL docs and third-party write-ups). The table owner bypasses
  policies unless `FORCE ROW LEVEL SECURITY` is set. A member of the owner role inherits that bypass.
  The planner does not push a user's filter below a policy when the filter uses a function or operator
  that is not `LEAKPROOF`, so that filter cannot use an index on the protected table. A view checks the
  underlying tables with the view owner's rights and policies unless `security_invoker` is set.
  `security_barrier` does not change whose rights apply; it only stops the planner from running a
  user's filter before the view's own conditions. Each pitfall has a Rust equivalent to test for:
  a maintenance path that skips the scope, a filter applied after the index scan, and a helper that runs
  with more rights than its caller. gbrain today enables RLS on 37+ tables with no `CREATE POLICY`, so it
  denies by default to any role without `BYPASSRLS`. Real isolation lives in application code and in GUC
  write guards (`gbrain.write_sources`, `gbrain.write_trust_tier`).

## Lock and queue mapping

This table maps each Postgres concurrency pattern that gbrain uses today to its replacement in the Rust
engine. The right column uses the typed operations from the plan's section "Concurrency without
PGLite-style locks" (D20). The base for all of them is one rule: a transaction reads at a snapshot, records
what it read and what it wants to write, and the commit step checks those sets. Nothing is locked while
the caller works.

| Today (Postgres / PGLite) | Where | Rust engine replacement | Model to copy |
|---|---|---|---|
| Job claim: `UPDATE ... WHERE id = (SELECT ... ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, then completion fenced by `lock_token` and `status = 'active'` | `minions/queue.ts` (claim near line 1463) | `claim_next_job(queue, worker, lease)`: read the head of a per-queue ready index at a snapshot, take the first job whose claim key is free, and commit a new `claim_generation` and `lock_token`. Two workers that pick the same job conflict at commit; the loser takes the next job, with no wait and no busy error. Keep the token fence on completion. Hand out claims from one task in the owner process when contention is high (a batch claim). | FoundationDB conflict ranges; TigerBeetle ordered batches |
| Stall reapers with `SKIP LOCKED`, 15 s grace | `minions/queue.ts` | `reclaim_stalled_jobs`: a scan at a snapshot, then a conditional write (compare `claim_generation`) per job. A worker that comes back late fails its token check. | Epoch fencing (SlateDB) |
| Idempotent submit (`ON CONFLICT (idempotency_key)`) | `minions/queue.ts` | `admit_job(spec)`: a unique-key index entry written in the same commit; a second submit with the same key returns the first job. | Unique keys in any OCC store |
| Admission, quota and max-waiting checks under `pg_advisory_xact_lock` | `minions/queue.ts` (near lines 385, 431, 460-488) | `admit_job` plus `reserve_capacity(key, delta, cap)`: a counter checked against its cap at commit. Counters split per worker or per shard where the cap allows. | FoundationDB atomic add plus a conflict range on the counter |
| Budget and rate advisory locks (`clientLockKey`; `hashKey` in `minions/rate-leases.ts`) and `FOR UPDATE` on budget ledgers | budget and rate-limit code | `reserve_budget`, `acquire_rate_lease(key, ttl)`: one conditional write on a ledger row; a conflict means another caller spent first, so read again and decide. | FoundationDB; TigerBeetle (balances by design) |
| Facts: a per-`source:entity` advisory lock around insert and supersession | `engine-sql/facts.ts` (near lines 122, 151) | `append_fact(entity, fact)`: the commit pipeline orders facts per entity (a new guarantee the Rust engine adds), so supersession checks see every earlier fact and callers never lock. | Commit-time sequence numbers (FoundationDB versionstamps) |
| `lockPageKeys` (about 76 calling files) and other key-family advisory locks (page body chunks, mention entries, origin, output writer, memory proposals, graduation nonce) | page-state guards and callers | Default: CAS on the row revision, so a stale writer fails at commit and retries on a new snapshot. Where the same work must not run twice at the same time (an LLM call, an embedding call): `single_flight(keys)`, keys sorted, held only inside the owner process until commit or abort, with waiters queued in memory and a bounded wait that ends in a typed `timeout` or `cancelled` result, never a busy error. It stops concurrent duplicates only: after an abort, a crash or an owner handoff the call can run again. Keep paid external calls outside transaction bodies that the engine re-runs, and use the provider's idempotency key or an effect journal where one exists. | Lance conflict matrix; Convex OCC |
| `FOR UPDATE` read-modify-write (config, OAuth codes) | about 225 sites | A plain transaction: the read goes into the read set, and the commit fails if that row changed. OAuth codes are single-use: a delete-if-present that only one caller can win. | SSI / FoundationDB |
| `FOR KEY SHARE` on pages while links and timeline rows are written | links and timeline writers | Validate at commit that the parent page still exists at the same revision (a read-set entry). A purge that races a link write fails one of the two. | Foreign-key checks as read sets (Turso #5955 shows the failure when this is missing) |
| Advisory lock 42 around schema init and migrations (transaction-scoped, with a session-lock fallback; a polled `pg_try_advisory_lock` with a deadline) | `postgres-engine/init-schema-lock.ts`, `schema-migration-lock.ts`, `migrate.ts` | `upgrade_format`: CAS on `format_version` in the store header. One process wins; others reopen at the new version. | Lance manifest commit |
| `gbrain_cycle_locks` TTL lease (`ON CONFLICT ... WHERE ttl < now()`, `acquisition_token`) | cycle and maintenance code | `acquire_lease(id, ttl)` returns a token with an epoch; `renew_lease(token)`; `assert_lease(token)` runs inside every commit the holder makes, so a holder that paused past its TTL cannot write. | SlateDB `WriterInit` epochs; FoundationDB |
| `LISTEN/NOTIFY` trigger `notify_minion_job_change` (Postgres only). Without a notification the worker's idle loop polls every 5 s by default; the sync wake polls every 1 s and falls back to polling when a LISTEN probe gets no answer in 3 s; PGLite gets no sync wake | `schema.sql`, `minions/worker.ts`, `minions/sync-queue-wake.ts` | Subscriptions on the commit log: a waiter registers a key range and the version it has seen; the commit step wakes it when a later commit touches the range. Across processes, the owner pushes over the client connection. | Convex reactive queries; Turso CDC |
| RLS on 37+ tables (no policies) plus GUC write guards `gbrain.write_sources` and `gbrain.write_trust_tier` | `schema.sql`, write paths | A `ReadScope` / `WriteScope` value with a private constructor that every engine method takes; the scope is pushed into index scans, never applied after top-k. Cedar decides who gets which scope. The commit version is the freshness token after a grant changes. The same error is returned for "not found" and "not yours". | Cedar; SpiceDB ZedToken; Qdrant `is_tenant` |
| Keyword ranking with `ts_rank` / `ts_rank_cd` (no corpus-wide statistics today) | full-text search | A new requirement for the Rust full-text index: if it uses BM25, keep term statistics per source (or per scope), so one tenant's documents cannot change another tenant's scores or reveal word counts. | Qdrant guidance on `idf` with a tenant filter (an inference, not a documented attack) |
| About 25 plpgsql triggers | `schema.sql` | Explicit steps in the write path, run in the same commit, each with a parity test against the trigger it replaces. | D18 typed methods |
| PGLite process lock (`pglite-lock.ts`), `pglite_busy` in 11 files | PGLite engine | `open_brain`: the first process becomes the owner; a second process connects as the owner's client, with handoff and retry by request id (plan PR 18). No process ever gets a busy error from opening the brain. | FoundationDB clients; pgrust thread per connection |

"No PGLite-style locking" does not mean "no synchronization at all". These places still serialize or wait,
and D20 allows each of them:

- **The commit pipeline.** It orders and validates commits, holds no user work, and groups many
  transactions into one fsync. A caller never reaches it directly.
- **`single_flight` keys.** A caller can wait on a key, but the wait is bounded and ends in a typed
  `timeout` or `cancelled` result.
- **The store's own internal latches and its single writer**, held only by the commit pipeline.
- **Filesystem resource locks** that protect files outside the store, as the plan keeps them.

Conflict retries are a different cost from waiting: the engine re-runs the transaction. The bake-off
measures both (lock wait, conflict retries, p99 at 1, 4, 16 and 64 writers).

## How to prove it

The systems with the best records (FoundationDB, TigerBeetle, SQLite) share one habit: the test harness came
first. A plan for gbrain's store layer, in the order to build it:

1. **Deterministic simulation from the first commit.** Run the engine, its clock, its disk and its network
   under one seeded scheduler. Rust tools: `turmoil` (network and time), `madsim` (a deterministic runtime),
   `shuttle` (random schedule exploration) and `loom` (exhaustive interleavings for small lock-free parts
   such as the commit queue). Inject torn writes, lost fsyncs, crashes and slow disks.
2. **A history checker, not assertions.** Record every operation's start, end and result, then check the
   history for serializability with an Elle-style checker. Jepsen found G2-item in PostgreSQL 12.3 at
   `SERIALIZABLE` this way, and found lost writes in ParticleDB's default mode.
3. **Test the defaults.** The ParticleDB 1.1.4 and NATS 2.12.1 reports both found loss in the default
   configuration. gbrain's default must be the fully durable, serializable mode, and that mode is the one
   under test.
4. **Keep and extend the TLA+ specifications** in `spec/tla/` for the claim, lease and commit protocols, as
   the plan already requires. CockroachDB's parallel-commit TLA+ is a model.
5. **The D20 stress test** (64 writers across 8 processes) runs against the history checker, not only for
   throughput.
6. **An outside test before M3.** Antithesis or a Jepsen analysis is a paid decision for the maintainer. Both
   found bugs that internal fuzzing missed (TigerBeetle, Turso).

## Sources

All links were read during this research on 2026-11-16 unless marked otherwise. Vendor claims are labelled
as such in the text above.

**pgrust and Postgres-family projects**
- https://github.com/malisper/pgrust (README, NOTICE, `proofs/README.md`, `crash-simulator/`)
- https://github.com/malisper/pgrust/issues/39
- https://pgrust.com/blog/pgrust-passes-100-of-postgresqls-regression-tests/
- https://pgrust.com/blog/pgrust-v0-3/
- https://malisper.me/postgres-in-rust-regression-suite/
- https://malisper.me/fixing-postgress-biggest-mistakes/
- https://news.ycombinator.com/item?id=50205816
- https://turso.tech/blog/a-new-modern-version-of-postgres-in-rust
- https://github.com/tursodatabase/turso/blob/main/postgres/COMPAT.md
- https://github.com/pgcentralfoundation/pgrx
- https://github.com/tensorchord/VectorChord
- https://github.com/paradedb/paradedb (PR #2142)
- https://neon.com/blog/pitr-deep-dive
- https://www.pgbouncer.org/ ; https://github.com/postgresml/pgcat ; https://github.com/pgdogdev/pgdog ;
  https://github.com/supabase/supavisor

**Embedded stores**
- https://github.com/tursodatabase/turso (README FAQ, `docs/manual.md`, `testing/concurrent-simulator/README.md`)
- https://github.com/tursodatabase/turso/issues/5790 ; https://github.com/tursodatabase/turso/issues/5955 ;
  https://github.com/tursodatabase/turso/issues/6335
- https://turso.tech/blog/concurrent-writes-in-practice
- https://www.sqlite.org/testing.html ; https://www.sqlite.org/th3.html ;
  https://sqlite.org/src/doc/begin-concurrent/doc/begin_concurrent.md
- https://github.com/cberner/redb (README, `fuzz/`) ; https://github.com/cberner/redb/blob/v4.6.0/docs/design.md
- https://github.com/fjall-rs/fjall
- https://github.com/meilisearch/heed ; https://github.com/LMDB/lmdb
- https://github.com/rust-rocksdb/rust-rocksdb ; https://github.com/facebook/rocksdb
- https://github.com/surrealdb/surrealkv (issue #376) ; https://github.com/surrealdb/surrealdb/issues/7472
- https://github.com/arthurprs/canopydb ; https://github.com/spacejam/sled ; https://github.com/gluesql/gluesql

**Distributed designs and correctness reports**
- https://apple.github.io/foundationdb/testing.html ; https://www.foundationdb.org/files/fdb-paper.pdf
- https://github.com/tikv/tikv ; https://jepsen.io/analyses/tidb-2.1.7 ; https://github.com/pingcap/tidb/issues/10444
- https://github.com/cockroachdb/cockroach/blob/master/docs/tla-plus/ParallelCommits/ParallelCommits.tla ;
  https://jepsen.io/analyses/cockroachdb-beta-20160829
- https://jepsen.io/analyses/tigerbeetle-0.16.11
- https://github.com/databendlabs/openraft ; https://crates.io/crates/openraft/0.10.0 ; https://github.com/tikv/raft-rs (issues #595, #599, #600)
- https://slatedb.io/ ; https://docs.rs/slatedb/latest/slatedb/wal/trait.WriterInit.html
- https://docs.convex.dev/database/advanced/occ
- https://jepsen.io/analyses/postgresql-12.3 ; https://jepsen.io/analyses/nats-2.12.1 ;
  https://jepsen.io/analyses/particledb-1.1.4

**Search indexes**
- https://github.com/lance-format/lance (`rust/lance/src/dataset/transaction.rs`) ;
  https://github.com/lancedb/lancedb/issues/3086
- https://github.com/quickwit-oss/tantivy (issue #2408)
- https://github.com/unum-cloud/usearch/issues/735 ; https://github.com/yugabyte/yugabyte-db/commit/ba7507a
- https://github.com/qdrant/qdrant/pull/9424 ; https://qdrant.tech/documentation/manage-data/multitenancy/
- https://turbopuffer.com/docs/architecture

**Access control**
- https://github.com/cedar-policy/cedar ; https://github.com/cedar-policy/cedar-spec
- https://github.com/authzed/docs/blob/main/app/spicedb/concepts/consistency/page.mdx
- https://github.com/openfga/openfga/issues/1777
- https://github.com/osohq/oso
- https://github.com/eclipse-biscuit/biscuit-rust
- https://www.postgresql.org/docs/current/ddl-rowsecurity.html ;
  https://www.postgresql.org/docs/current/sql-createview.html ;
  https://www.postgresql.org/docs/current/rules-privileges.html
- https://docs.rs/diskann-rs/latest/src/diskann_rs/incremental.rs.html (secondary)
