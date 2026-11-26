# Rust engine: the multi-user server (design note)

Status: design only. No engine code changes with this note, and nothing here is approved to build. Each
server phase (M1 to M5 in [RUST_ENGINE.md](../RUST_ENGINE.md#path-to-a-multi-user-server)) still starts
only with the maintainer's yes, and each groundwork item below lands only after the maintainer picks it.
The Dec 1 targets (shadow release Nov 26, opt-in swap Dec 1) come first; nothing here takes a landing
slot from them.

Pinned commits: master `93ac9b205a`, Rust trunk `rust-engine/main` `3e79ea5896` (2026-11-24). Paths
with line numbers are at the trunk commit unless the line says master. The plan sections this note
builds on are "Process model", "Concurrency without PGLite-style locks", "Data on disk" and "Path to a
multi-user server", and decisions D17, D19, D20, D21 and D22. The design choices come from the
prior-art map, [multi-user-prior-art.md](../../research/rust-engine/multi-user-prior-art.md).

## TL;DR

- We learned that the landed store is closer to a server than the plan assumed. It already has an
  optimistic, serializable commit pipeline with group commit (`occ_kv.rs`, behind
  `GBRAIN_RUST_CONCURRENT_WRITES=1`), a durable commit sequence, an injected clock and id source
  (`env.rs`), a seeded simulation crate (`gbrain-sim`), a format registry, and an owner socket with
  request ids, deadlines, cancel, bounded queues and an "outcome unknown" contract.
- We also learned where it is still tied to one process on one machine: the access record a call runs
  under is asserted by the client, not proved; writes carry no origin (which machine, which process);
  the commit sequence is a counter, not a log a follower can read; explicit transactions hold the
  whole writer; and the write journal's comment and code assume one owner process.
- You should pick a small set of default-off groundwork items now (the ranked list below), so the
  server phases extend this code instead of rewriting it. The top items cost a few hundred lines each,
  change no output while off, and can land after Dec 1 without taking a swap slot. The conformance
  and property tests can be written now and run today on PGLite, Postgres and the single-writer
  Rust arm, with their multi-writer cases pending.

## What "multi-user" means here

Three steps, each building on the last. They are the plan's phases M1 to M3; M4 (replication and high
availability) and M5 (Postgres deprecation) are covered only where they constrain today's format.

1. **M1, one server, many clients.** One Rust engine process serves a brain. Clients on the same
   machine or over the network call it through a wire protocol that carries the typed `BrainEngine`
   methods. CLI, JSON and MCP output stay byte-identical to an embedded brain.
2. **M2, many users.** The server knows who each caller is. Every read and write runs under a scope
   the server built from an authenticated credential, never under a scope the client sent.
3. **M3, writers on many machines.** Several hosts write the same brain at once through the server.
   Claims, leases, fencing and per-entity fact order hold across hosts. A multi-host Postgres brain can
   move to a served Rust brain through shadow mode and back.

What it does not mean: several processes opening the same store files directly, multi-primary
replication, or offline writers that merge later. The prior-art map rules out shared-file writers
(file locks come back, D20), and the plan names one primary that writes (M4: "only one primary
writes").

## What exists today

These pieces are already server-shaped. The server phases should reuse them, not replace them.

| Piece | Where | Why it matters for the server |
|---|---|---|
| Optimistic serializable commits with one ordered pipeline and group commit | `rust/crates/gbrain-store/src/occ_kv.rs:1-40` | This is the FoundationDB design the prior-art map recommends. Writers never hold the record file's writer; the pipeline validates read sets in commit order and writes each batch with one fsync. Off by default (`OpenOptions::concurrent_writes`, `lib.rs:156-160`). |
| Non-conflicting counter writes | `kv.rs:41-82` (`allocate`, `raise_counter`, `add_i64`, `counter_below`) | The plan's "hot keys" rule: quotas, caps and id sequences never retry-storm. |
| Durable, monotonic commit sequence | `redb_kv.rs:19-27` (`SEQ_KEY`), `redb_kv.rs:292-315`, `Store::commit_version` (`lib.rs:503-506`) | The seed of a log position and a read-your-writes token. It is written in the same redb commit as the records. It numbers batches, not single writes (audit row A6), and the TypeScript wrapper drops the value `commitTransaction` returns (`src/core/rust-engine.ts:473`). |
| Injected time and ids | `env.rs:5-15` (`Env`), `TransactionClock` (`transactions.rs:62-90`) | The simulation can replay a seed; a server can stamp server time. |
| Simulation crate and history checkers | `rust/crates/gbrain-sim/src/` (seeded scheduler, fault-injecting disk, `check.rs` serializability and recovery checkers); `rust/crates/gbrain-store/tests/sim.rs`; `tests/occ_history.rs` (4, 16 and 64 writer threads on the optimistic store) | Deterministic simulation from day one, the habit the prior-art map credits to FoundationDB and TigerBeetle. Gap: the seeded scheduler drives only the single-writer store; the optimistic store is tested with OS threads, so a failing interleaving is not always reproducible (`occ_history.rs:23-25`). |
| Format registry with reserved rows | `rust/docs/store/format.md` "The registry", `tests/format_registry.rs` | A format number can be claimed for multi-writer metadata before any branch writes it. |
| Idempotent write identity | `journal.rs:8-12`, `RequestRecord` (`journal.rs:202-237`) | A write is `(principal kind, principal id, request_id)`; replay returns the stored receipt. `extra` (`journal.rs:233-237`) keeps unknown fields, so an added field survives an older build. |
| Owner socket protocol v2 | `src/core/rust-engine/owner-ipc/protocol.ts:1-60` | Versioned hello, call ids, deadlines, cancel, bounded queues (`owner_busy`), `outcome_unknown` with confirming reads. This is the seed of the M1 wire protocol. |
| Access checks in the store | `rust/crates/gbrain-store/src/access_*.rs`, `page_visibility.rs`, `owner_only.rs` | Visibility is computed in the store from an access record, not in the napi layer, as D19 asks. |

The audit below lists what still depends on one writer, one owner process or one machine.

## Target shape

```
  CLI / MCP / agents on host A        CLI / MCP / agents on host B
            |                                   |
     typed engine client                 typed engine client       (TypeScript, same BrainEngine API)
            |   wire protocol (M1)              |
            +---------------+-------------------+
                            |
                 +----------v-----------+
                 |  gbrain server       |  authenticate -> principal -> Scope (M2)
                 |  session per conn    |  deadlines, cancel, permits, request ids
                 +----------+-----------+
                            |  Store API seam (typed operations + Scope + WriteOrigin)
                 +----------v-----------+
                 |  gbrain-store        |  typed operations, I1-I15 access checks, write hooks
                 |  optimistic txns     |  read/write conflict ranges per transaction
                 +----------+-----------+
                            |
                 +----------v-----------+
                 |  commit pipeline     |  validate in order -> assign commit version
                 |  (one per brain)     |  -> group commit -> append commit log -> publish
                 +----+------------+----+
                      |            |
              records.redb     commit log  ----> follower / backup / shadow (M4)
```

Three seams carry the design. Each can be cut now without a server.

1. **The Store API seam.** Every store entry point takes an explicit `Scope` (who reads or writes,
   and which sources) and, for writes, a `WriteOrigin` (which writer, which process incarnation,
   which machine). Today the access record arrives as a call argument and the origin does not exist.
2. **The commit seam.** The pipeline already numbers commits, but the number counts batches: every
   transaction accepted into one group commit gets the same sequence (`occ_kv.rs:442`, `:502`). It
   should give each transaction its own position (batch sequence plus index in the batch) and emit one
   commit record per transaction (position, write ids, origin, the logical changes), in the same redb
   commit as the records.
3. **The session seam.** A connection, not a thread or a process, owns a transaction, a snapshot and
   a writer permit. The owner socket already models a connection; the store's explicit transaction
   does not yet (it holds the whole writer, below).

## M1: server mode and wire protocol

**Process.** M1 runs one server process per brain. Open decision M below: the server can be
`gbrain serve` (TypeScript) hosting the in-process addon, or a native Rust binary. The recommendation
is `gbrain serve` for M1, because operations, the persistence coordinator, hybrid fusion and the
error contract are TypeScript and must stay byte-identical (plan, "What changes and what stays"). The
Store API seam keeps a native server possible later.

**What the wire carries.** The plan says the wire carries typed `BrainEngine` methods. That matches
the owner socket today (`{ t: 'call', id, member, args }`). Two call shapes are needed:

- *Member calls*: one `BrainEngine` member, one round trip. Reads and single writes.
- *Whole operations*: one write operation sent whole and run in the server's own transaction
  (`owner-ipc/whole-op.ts` already defines this for the four `import*` members). This is how a remote
  client writes without holding a transaction open across the network.

Interactive transactions over the wire (a client opens a transaction and sends many calls in it) are
possible but costly: a slow client holds a snapshot, and with today's exclusive transaction it holds
the whole writer. M1 should ship whole operations first and interactive transactions only on the
optimistic path (open decision N).

**Protocol rules to keep from the owner socket.** Versioned hello with capabilities; a call id per
connection; `deadline_at` and `cancel`; bounded queue, in-flight bytes and connections with a
retryable `owner_busy`; exactly one result per call; `outcome_unknown` when a started write's answer
was lost, with a confirming read that waits for the earlier call (`confirming-reads.ts`). These are the
rules a network client needs most, and they are built and tested.

**Protocol rules to add.**

- A server-wide request id, not a per-connection call id, so a client that reconnects can ask "did
  request R commit?" and retry by request id (the plan's PR 18 target). The write journal already
  keys idempotency on `(principal, request_id)`.
- A read-your-writes token: every write result carries the commit version; a later read may say
  "at least version V" and the server waits (bounded) until its published version reaches V. This is
  SpiceDB's consistency token, and the commit sequence already is the number.
- Framing that is not one JSON line per frame: a length prefix and a binary value encoding for vectors
  and large bodies. The current JSON-line codec (`owner-ipc/codec.ts`) is fine on one machine; over a
  network the 128 MiB frame limit and JSON vectors are a cost. Keep the tagged value model.
- Transport: Unix socket (as today) plus TLS over TCP. Authentication moves into the hello (M2).

**Exit proof (from the plan).** The engine tests and memory-verb conformance pass through the wire;
CLI, JSON and MCP goldens are identical against an embedded brain and a served brain; the added
latency is measured and listed.

## M2: per-user access

Today the access record a call runs under is built by the caller. In process that is the CLI or MCP
layer, which is trusted to build it. Over the owner socket the client sends it (`protocol.ts`: "`access`
is the caller's access record ... the owner runs the call under it"), and the socket's 0600 mode makes
the client as trusted as the CLI. A multi-user server cannot trust that field.

**Rule: only the authentication boundary builds a scope.**

- The server authenticates the connection in the hello (an OAuth or API token; the existing
  `access_tokens`, `client_grants` and `credential_*` store families hold the records).
- It resolves the principal to a `Scope`: allowed sources, member identity, labels, trust tier,
  read-only or read-write. `Scope` has a private constructor in `gbrain-store`; napi and TypeScript
  can pass one along but cannot make one from parts on the server path.
- Every store entry point takes the `Scope`. Visibility filters run inside the index scans, never
  after top-k (the plan's "Privacy and visibility" rule and the prior-art RLS pitfalls).
- "Not found" and "not yours" return the same error.
- Keyword statistics stay per source if a BM25 ranker ever ships, so one tenant's pages cannot move
  another tenant's scores (prior-art map, lock and queue table).

**Policy decision.** Open decision O: keep gbrain's current access model (sources, members, labels,
`readable_by`, folder rules) as hand-written checks in `gbrain-store`, or put the decision in Cedar.
The recommendation is to keep the hand-written checks through M2, because they are what the parity
suite proves today, and to revisit Cedar only for delegation tokens.

**Freshness after a grant change.** A revoke commits at version V. A read that must not see data
written after the revoke asks for "at least V". The commit version is the token; no second store.

## M3: writers on many machines

**Writers write through the server.** No host opens the store files except the server. Remote
writers send whole operations (or optimistic transactions) over the wire.

**Conflict model: serializable optimistic transactions, one ordered commit pipeline per brain.** This
is what `occ_kv.rs` already does in one process. A transaction reads at a snapshot version and records
its read keys and ranges and its writes. The pipeline takes commits in order, checks each read set
against every write committed after that snapshot and every write already accepted in the current
batch, assigns the commit version, writes the batch with one fsync, and only then answers. A
transaction that loses gets `write_conflict` inside the engine, and `Store::write` re-runs it from a
fresh snapshot (`WRITE_RETRY_LIMIT`, `lib.rs:251`). It never re-applies old writes (the TiKV lesson in
the prior-art map). Snapshot isolation alone is not enough: quotas, caps and single claims break under
write skew, so read sets are checked, not only write sets.

What changes for M3:

| Topic | Today (one process) | M3 |
|---|---|---|
| Who validates | the pipeline thread in the owner | the same pipeline in the server; remote transactions send their read and write sets with the commit |
| Explicit transactions | `begin_write_exclusive` stops the pipeline until the transaction ends (`occ_kv.rs:31-36`, `transactions.rs:8-9`) | optimistic transactions with savepoint layers; exclusive mode only for format upgrades and maintenance |
| Page-key locks (`lockPageKeys`) | held in memory, safe only because the transaction holds the writer (`transactions.rs:32-37`) | the plan's `single_flight(keys)` in the server, plus compare-and-set on the row revision at commit |
| Retry queueing on hot keys | in-memory key locks for retried transactions (`occ_kv.rs:24-29`) | unchanged, server-local; hot counters keep using `add_i64` / `counter_below` / `allocate` |
| Id allocation | from the shared sequences in the pipeline (`occ_kv.rs:17-20`) | unchanged; ids come from the one server, so two hosts never collide |
| Leases and claims | the native admission journal has no claims, leases or recovery records (`journal.rs:20-22`); the TypeScript-compatible persistence path on Rust already serves unbound write claims, stamping, renewal and stale-claim expiry (`src/core/rust-engine/store-members/persistence.ts:234-236`, `:291-301`, `:318-321`), while managed and worktree-bound persistence stays held (`store-capabilities.ts:18-23`) | epoch-fenced leases: `acquire_lease` returns a token with an epoch, and `assert_lease` runs inside every commit the holder makes, so a paused holder cannot write (SlateDB) |
| Fact order per entity | one writer orders facts | the pipeline assigns a per-entity sequence at commit (a versionstamp) |
| Clocks | the owner's wall clock (`SystemEnv`), one time per transaction | server time is the only time written to rows; a client's clock is never trusted for order; the commit version is the order |
| Write identity | `(principal, request_id)`, journal `sequence` | adds `WriteOrigin` (writer id, process incarnation, machine id) on every journal row and commit record |

**Why no hybrid logical clock.** With one primary, the commit version is a total order and the
server's clock stamps `created_at`. A hybrid logical clock only pays off with several primaries,
which this design does not plan. If M4 failover moves the primary, the new primary's first commit
version is above the old one's last (the log carries it), and `created_at` takes the larger of server
time and the last committed time, so time never runs backwards in the records.

**Hosts and fencing.** Each host's writer registers once (`register_consumer`) and gets an epoch.
Claims and leases carry `(epoch, token)`. A host that comes back after a partition with an old epoch
is refused at commit. `multiple_writer_hosts` stops refusing a brain only when the server serves it.

## Write journal and store format changes

The store format changes below are designed now and built later. Each takes a format number from the
registry when it is built. None changes any output while off.

1. **Write origin on every journal row.** gbrain already has a machine identity: a random UUID in
   `host.json` under the persistence home (`src/core/persistence/identity.ts:111`, `localHostId`; `hostIdFor` at `:148` answers it per engine), and the
   SQL engines' `persistence_requests` table already has `admitter_host_id` and `consumer_host_id`
   columns (schema migration v178). Swap readiness counts writer hosts from them
   (`src/core/engine-swap/readiness.ts:280`, `multiple_writer_hosts`). The Rust native journal leaves
   both columns null: a natively admitted request has an empty `extra`, and `fill_request_columns`
   (`persistence.rs:197`) fills listed columns with null. The change: the native journal stamps
   `admitter_host_id` from the caller's host id, plus a process incarnation id kept in `extra`. It
   reuses an existing column, so the receipt and row shapes do not change; only a null becomes a
   UUID in rows that already carry the column on Postgres.
2. **A stable write id.** The journal's `id` field is already a UUID. Make it a time-ordered UUID
   (version 7) so ids sort by creation and can name a commit record without a lookup. Parity: the id
   never reaches CLI, JSON or MCP output except where the Postgres engine shows its own id; check
   before changing (open question).
3. **A commit record per commit.** In the same redb commit as the records, the pipeline writes one
   record under a key tag of its own: the version, the write ids it carries, their origins, and the list
   of changed keys with their operation (put, delete, add, max). Logical, not physical: a follower
   applies it to its own store. Retention is bounded (a size or age cap), and a follower that falls
   behind the cap installs a snapshot first. Every letter tag is taken; tag `2` is free (`keys.rs:127-129`), or the log can take a sub-tag under
   `M`. `0x00` stays the adapter's.
4. **A format header that says the writer model.** `FORMAT` gains `writer_model` (`single`, `occ`,
   later `served`) and `log` (`none`, or the oldest retained commit version). A build that does not
   understand a model refuses the brain, as today's `format_version` check does.
5. **Snapshot stream.** A follower or backup reads a redb read transaction at version N (already a
   consistent snapshot, `OccBase::versioned_snapshot`) and then the commit records after N.
   Point-in-time restore is "open at log position N" (Neon's design).

**Replication hooks (M4, not built).** The follower reads the commit log from a position over the
wire protocol. openraft can later sit under the commit log for failover (prior-art map: adopt for
M3/M4 only; avoid raft-rs). Shadow mode would also gain an exact follower: today it re-reads
invalidated keys and runs a reconcile, because there is no log (plan, "How the shadow stays in step").

## Audit: landed choices that are costly to undo

The plan's rule (D19, D20, D22): the store core must not depend on the single-writer, one-owner-process
setup. Each row below is a landed choice that does depend on it, or that a server cannot trust. "Both"
means master `93ac9b205a` and trunk `3e79ea5896` have it. Master has an earlier, smaller
`store-members/` layer, no `owned-brains.ts` and store format 7 instead of 8; rows that cite a
`store-members/` file are at trunk. Cost to undo: S is a day or less, M is a planned
change across several files, L is a protocol, storage or format change.

Nothing here is a bug today. Every row is safe in the embedded phase, because one process owns the
brain and explicit transactions hold the whole writer. The rows say what breaks when that stops being
true, and what is cheap to do before more code depends on it.

### Store core (`rust/crates/gbrain-store`)

| # | Where | What it assumes | Cost to undo later | Cheap fix now |
|---|---|---|---|---|
| A1 | Lock skips in 58 places on trunk (33 TypeScript, 25 Rust; list in "Appendix: lock skips that rely on one writer"), plus `src/commands/agent-register.ts:546` on the unmerged branch `rust-engine/client-grant-write-rust` (`9725bb8c89`), which skips the per-name advisory lock on Rust, guarded by a two-register pin (`test/engine-parity/oauth-clients.test.ts:457` on that branch) | A Postgres or PGLite lock (`FOR UPDATE`, `FOR SHARE`, an advisory lock, `SKIP LOCKED`) is a no-op on Rust because an explicit transaction holds the store's whole writer (`transactions.rs:571` -> `occ_kv.rs:646-661`). This stays true with `GBRAIN_RUST_CONCURRENT_WRITES=1`, because explicit transactions stay exclusive there too. It stops being true the day explicit transactions become optimistic (M3) or a second pipeline exists. The skips are silent: nothing fails if the assumption goes. | L. Each site needs its own typed guarantee from the D20 table (compare-and-set, `single_flight`, a read-set entry). The count grows with every branch that serves a locking member. | One engine capability, `serialized_transactions`, that Rust reports today. Every skip checks it instead of `lacksRawSql` or nothing, so an engine mode without it refuses `engine_capability_missing` instead of racing. Same branch taken today, so parity holds (groundwork item G1). |
| A2 | `transactions.rs:564-588` (`begin_transaction` takes `begin_write_exclusive`), `occ_kv.rs:31-36`, `:645-675`; no deadline anywhere in `transactions.rs` | An explicit transaction stops every other commit in the brain until it ends, and a stuck caller stops the brain. | M. Optimistic explicit transactions need savepoint layers that record read sets, and callers that can take a typed conflict. | A wrapper deadline that rolls a stuck transaction back (bounded wait, as D20 requires). Behind a flag until measured (G10). |
| A3 | `transactions.rs:32-37` (page-key locks held in memory), `pages.rs:1626` (`lockPageKeys`: "one process owns the brain") | `lockPageKeys` holds keys only in this process and is safe only because the transaction holds the writer. | M. Becomes `single_flight(keys)` plus compare-and-set on the row revision. | None now; the `w` tag is already reserved for a lock queue that outlives a transaction. |
| A4 | `occ_kv.rs:347`, `:928-960`, `:477-493` (id sequences cached in memory, folded back at commit) | One allocator per record file. Two processes opening one file would hand out the same ids. Today the redb file lock stops a second opener. | M. Every row carries these ids. A second allocator needs id ranges leased per process or ids drawn inside the commit. | None now. Record it as a dependency on A5, not as safe. In M1 to M3 all writers go through one server, so one allocator stays correct. |
| A5 | `redb_kv.rs:31-35`, `:77-80` (`DatabaseAlreadyOpen` -> `store_locked`) | One process holds the record file. This is the only hard process barrier. | L if several processes must open the files (not planned: the prior-art map rules it out). | None. The design keeps it: other processes reach the brain through the owner, later the server. |
| A6 | `occ_kv.rs:442`, `:502` (one sequence for every transaction in a batch); `kv.rs:33-35` | The commit sequence orders batches. A follower or a read-your-writes token cannot name one write. | M once callers depend on the batch number. Cheap now: no caller reads it (`src/core/rust-engine.ts:473` drops it). | Return `(sequence, index in batch)` from commit. Nothing reads it yet, so output is unchanged (part of G5). |
| A7 | `journal.rs:5` ("One process owns the brain"), `journal.rs:20-22` (leases, claims and recovery records not ported), `RequestRecord` (`journal.rs:202-238`) | The native write journal has no origin (machine, process) and no claim or lease model. The TypeScript path stores `admitter_host_id` and `consumer_host_id` in `extra` (`persistence.rs:769`, `:887`, `:1019`, `:1180`) as the caller gives them; the native path leaves them null. | S for an added field (serde default); M if the server must check it. | Stamp `admitter_host_id` on native requests from the caller's host id, behind a flag (G4). |
| A8 | `persistence/notifier.rs:282-294` (lease expiry on the local clock, `pid` stored); `jobs/wake.rs:1041-1046`; `persistence.rs:982-988` (`claim_expires_at`) | One clock for every claimant, and a `pid` means something only on the machine that wrote it. | M. Lease rows store absolute instants. | None now. With one server, server time is the only clock; keep `pid` as diagnostic text. |
| A9 | `occ_kv.rs:209-262` (`KeyLocks::acquire` waits on a `Condvar` with no timeout) | A retried transaction can wait forever for a hot key. Only on the opt-in optimistic store. | S. | `wait_timeout` on the caller's deadline, ending `timeout` (G10). Off-path by default: the optimistic store is opt-in. |
| A10 | `keyword/vector_cache.rs:141-144` (`static CACHE: OnceLock<...>`, 64 MiB) | One cache per process, shared by every store in it. The plan forbids process-wide caches. | S. Keyed by exact input text, so results are correct across stores; only the memory bound is shared. | Move it onto `Store`, like the per-store `VectorCache` (`lib.rs:209-212`) (G12). |
| A11 | `keyword/index_build.rs:271`, `lib.rs:403-408`, `:428-434` | At most one builder runs per store, and only when the builder is enabled and the index needs a build (read-only opens never run one, `lib.rs:323`). Two writable openers that both needed a build would both run one (duplicate work, still correct under optimistic commits). | M. A lease would elect the builder. | None now. |
| A12 | `owner_only.rs:1-8`, `:44-52` (the TypeScript member picks `OwnerOnlyForm` and sends it) | The caller decides which owner-only form applies. The plan says the engine decides access. | M. | Derive the form in the store from the access record, with a parity run on both forms (part of G8). |
| A13 | `format.rs:50-58` (`FormatRecord`: no writer model, no log position) | A format says what the records are, not how they are written or where a log starts. | M for a new keyspace or field after more brains exist; each bump refuses older builds. | Reserve the next format number and one key tag for multi-writer metadata and the commit log in the format registry before another branch takes them (G5). |
| A14 | Comments that state the single-writer model as a fact: `journal.rs:5`, `pages.rs:1626`, `timeline/held.rs:9`, `takes/held.rs:9`, `trust/proposals.rs:22`, `mention_state.rs:13`, `facts/purge_writes.rs:17` | They describe today's mode as the only mode, so a reader of a future optimistic transaction trusts them. | S. | Reword to "while explicit transactions hold the writer (`serialized_transactions`)" (G12). |

### Binding and owner process (`gbrain-napi`, `src/core/rust-engine*`)

| # | Where | What it assumes | Cost to undo later | Cheap fix now |
|---|---|---|---|---|
| B1 | `src/core/rust-engine/store-members/page-visibility.ts:28-39`, `fact-visibility.ts:39-59`, `remote-floor.ts:17-29`, `private-provenance.ts:63-76`; applied in `page_visibility.rs:91-101`, `facts/privacy.rs:67-84` (trunk) | TypeScript renders the caller's privacy policy, including the caller's member and group identity (`facts/privacy.rs:73-84`), and the store applies it as given. The store receives these identity claims but does not authenticate where they came from or derive the full policy itself. A wrong policy gives a wrong answer. | L. Every visibility member would take an authenticated identity and derive the policy in the store. This is the largest M2 cost. | Design now (M2 "only the authentication boundary builds a scope"); no code before Dec 1. |
| B2 | `owner-ipc/client.ts:320-322`, `whole-op.ts:76-78`, `routes.ts:58` (`OWNER_IPC_REMOTE_READS` checked only in the client); the owner (`server.ts`) does not check | A remote caller's write is refused in the client process. A client that skips the check sends it, and the owner runs it with the owner's access. Safe today because the socket is private to one OS user: mode 0600 outside Windows (`server.ts:525`), plus a kernel peer-uid check on Linux x64 and arm64 and on macOS only (`server.ts:29-33`, `:367-373`); other Unix systems rely on the file modes, and a Windows named pipe gets no peer check. | M. A server must refuse on its side and know the caller type. | Owner-side check of the same allow-list for frames marked remote, behind a flag (G11). |
| B3 | `owner-ipc/server.ts:484-488`, `client.ts:353-354`, `protocol.ts` header ("the owner runs the call under it") | The access record in a frame is trusted as the CLI's own. | M. A server must check it against an authenticated user before `withCallerAccess` runs. | None now; M2 design. |
| B4 | `owner-ipc/client.ts:257`, `:324` (`nextId` counter per connection); `server.ts:376` (calls keyed per socket) | A call id is unique only on one connection. A reconnecting client cannot ask "did request R commit?". | M. Every pending map and cancel frame keys on the number. | An optional `req` UUID on `call` and `fn` frames, sent and logged only when a flag is on (G7). |
| B5 | `store-members/transactions.ts:44`, `store-members/write-context.ts:37`, `write_trust.rs:88-95` (principal and request id set by TypeScript on the transaction) | The store records who wrote a row but does not check that the principal may write. | M. | None now; the server sets the principal from the authenticated user. |
| B6 | `src/core/rust-engine.ts:105` (module `AsyncLocalStorage` for the transaction scope), `:167` (`_writer` gate), `:219-225` (`_takeOver`, one `_owner` field) | One engine object has one writer gate and one owner role. A server with many connections on one engine needs the gate per connection or in the store. | M. | None now. |
| B7 | `src/core/search/private-visibility.ts:864-865`, `:1176-1177` (module-level `Set`s for alias honoring and exposure) | One brain's setting applies to the whole process when no engine scope is active. | M. | Note it; a server build requires an engine scope on every read. |
| B8 | `src/core/persistence/consumer-election.ts:133` (`single_process_engine` for an engine that is not Postgres, beside a separate forced-consumer condition); Rust's typed heartbeat members are no-ops (`src/core/rust-engine/store-members/persistence.ts:323-332`); `engine-capabilities.ts:81` (`single_owner` tied to engine kind). PGLite-only branches a Rust brain does not take: `consumer-heartbeat.ts:155-158`, `persistence/journal.ts:1096-1098` (vacuum), `effect-journal.ts:266-269` (PGLite plus a held datastore lock) | Consumer election treats a one-process engine as the full consumer, and Rust keeps no heartbeat rows. True for a Rust owner today; a server with clients on several hosts needs real heartbeats. | M. | Replace the election branch and the heartbeat no-ops in M1; leave the PGLite-only branches alone. |
| B9 | `src/core/rust-engine/owned-brains.ts:15` (trunk only) | A module-level map of brains this process owns, read by swap readiness. | S. | None. |

### Already server-ready (keep)

Owner protocol version and hello refusal (`protocol.ts:44`, `server.ts:405-412`); duplicate call id refusal
(`server.ts:436-442`); deadlines, queued and running (`server.ts:489-506`); permits and bounds
(`server.ts:212-268`, `:447-449`, `:374`); retryable `owner_busy` (`routes.ts:246-257`); peer uid check on
Linux x64 and arm64 and macOS (`server.ts:29-33`, `:367-373`); `outcome_unknown` with confirming reads (`routes.ts:121-183`,
`confirming-reads.ts`); per-handle writer and bind guard (`store_bind.rs:50-82`); capabilities from the
member table (`store-capabilities.ts:41-54`); per-transaction snapshots (`occ_kv.rs:689-701`);
optimistic validation from a snapshot and a conflict index (`occ_kv.rs:279-299`, `:529-545`); one fsync
per batch (`occ_kv.rs:466-475`); `brain_id` compared with an existing `FORMAT` record on open (`lib.rs:296-300`, `:327-330`); fail-closed access
flag when a process cannot write the scan record (`access_flag.rs:93-96`).

### Not verified

Who mints effect and write-claim tokens and whether they are monotonic (`persistence/effect_worker.rs`,
`persistence.rs:1702` takes them from the caller); whether every native write path creates a journal
row; whether the napi build turns on the `fjall` bake-off feature; whether every owner-socket caller
sends an `access` record; the Windows named-pipe path.

## Groundwork we can ship sooner

**Landing rule.** Through Dec 1, the landings that matter are the trunk snapshots that carry the shadow
release (Nov 26) and the opt-in swap (Dec 1). No item below takes one of those slots. Each item is built
on its own branch, merges into `rust-engine/main` after the Dec 1 swap snapshot is on master (target
Dec 2), and rides the first snapshot after the swap. "Write now" means the work touches no file a swap
branch edits, so it can be written and reviewed now and merged without conflicts later. Items that
touch the commit pipeline, the owner socket, the write journal, the store members or the parity pins
must wait to merge, because those are the files the swap work changes every day.

Every item is off by default or changes no answer, and each says how that is proved: the parity suite
(PGLite, Postgres and Rust arms), the Rust tally pins (`test/engine-parity/rust-tally.tsv`) and the
CLI, JSON and MCP goldens unchanged at the merged head. Sizes are estimates in changed lines, code plus
tests.

Ranked by what it buys for the server phases per line and per unit of risk:

| Rank | Item | Kind | Size | Off path | Proof it changes nothing while off | Risk to Dec 1 | When |
|---|---|---|---|---|---|---|---|
| G1 | Lock skips fail closed. The Rust engine reports a new capability, `serialized_transactions` (true while explicit transactions hold the writer, in both store modes). Each lock skip in audit row A1 checks it; a Rust-side skip calls one store assertion. A guard counts the marked sites so a new skip must be marked. | dark code + guard | about 300 | No flag: the capability is always on today, so every skip takes today's branch. Without it a skip refuses `engine_capability_missing`, never races. | Same branch on every arm; parity suite, tally pins and goldens unchanged. A unit test removes the capability from a test engine and checks the refusal. | None if merged after the swap. Touches about 30 files that swap branches also touch, so it must not merge earlier. | Write Dec 1-2, merge Dec 2-3. |
| G2 | Multi-writer conformance suite against the engine interface (details in "Tests to write now"). | tests | about 820 (Rust 420, TypeScript 380, harness 15) | Multi-writer cases are pending: `#[ignore = "multi_writer"]` in Rust, and a `multi_writer` capability that skips the Rust arm in the parity harness. | Adds cases only. Postgres and PGLite run every case they can express today (PGLite's one connection cannot express C13, C17 or C21); C11 and the C21 token define new rules and stay pending on every engine until built; the Rust arm counts them as skipped, which `checkRustTally`'s sum check accepts (`rust-tally.ts:70`); no existing case changes. | None to behavior. Adds about one or two minutes to the PGLite and Postgres parity arms (estimate). | Rust half: write now, merge any time (new file only). TypeScript half: write now, merge Dec 2 (it touches the harness, `coverage.tsv`, `test/postgres-unit-arms.txt` and the tally pins). |
| G3 | Both store modes in CI. The store tests' opener runs each concurrency test on the single-writer store and on the optimistic store (`tests/common/mod.rs:38-47`), and one CI cell runs the Rust store tests with `GBRAIN_RUST_CONCURRENT_WRITES=1`. | tests + CI | about 40, plus one workflow cell | The default store stays single-writer; only tests open the optimistic one. | No product code changes. | None. A new CI cell adds a few minutes to the Rust CI job. If the optimistic mode fails a test, that is a finding, not a Dec 1 blocker (the mode is off). | Write now; merge Dec 2 (edits `.github/`, a shared file that needs a heads-up). |
| G4 | Write origin on native journal rows. The native write journal stamps `admitter_host_id` from the caller's host id (`hostIdFor`, `src/core/persistence/identity.ts:148`) and a process incarnation id in `extra`. | dark code | about 190 | `GBRAIN_RUST_WRITE_ORIGIN=1`, default off. Off, the column stays null, as today. | Off: byte-identical rows and receipts. On: the column matches what the SQL engines already store, which a parity case can show. | Touches the write journal, which the swap depends on: merge after the swap only. | Merge Dec 3 or later. |
| G5 | Commit positions and a commit record. Commit returns `(sequence, index in batch)` (audit row A6). With a flag on, the commit pipeline also writes one commit record per transaction (position, write ids, origins, changed keys and their operation) in the same redb commit, under a reserved key tag; a store written that way is stamped with a reserved format number so older builds refuse it. | dark code | about 560 (positions 60, record 300, tests 200) | `GBRAIN_RUST_COMMIT_LOG=1`, default off. The position is returned but nothing reads it. | Off: no new key is written (a test dumps every key of a brain written with the flag off and compares it with today's build); no output reads the position. | Touches the commit pipeline, the path of every write. Highest regression risk on this list: merge only after the swap, and with its own review. | Merge after Dec 3; reserve the key tag and the format number in the format registry first (tag `2` is free, `keys.rs:127-129`). |
| G6 | Property and simulation tests, plus deterministic scheduling for the optimistic store (details below). | tests | about 560, plus the scheduler work (decision Q) | Tests only. | No product code changes. | None. | Write now; merge any time after Dec 1 (new Rust test files). |
| G7 | Request ids on the owner socket. Clients put an optional `req` UUID on `call` and `fn` frames; the owner logs it and, with the flag on, returns the commit position in write results. | dark code | about 220 | `GBRAIN_RUST_OWNER_REQUEST_IDS=1`, default off. Off, frames are byte-identical to today. | Off: frame and codec tests unchanged; owner socket goldens unchanged. | The owner socket carries the shadow follower and CLI delegation: merge after the swap only. | Merge Dec 4 or later. |
| G8 | Access self-check. With a flag on, the store re-derives the caller's privacy policy and owner-only form from the access record and refuses when it differs from what TypeScript sent (audit rows A12, B1). This is the first step of "only the authentication boundary builds a scope". | dark code + test mode | about 250 | `GBRAIN_RUST_ACCESS_SELF_CHECK=1`, default off. | Off: unchanged. On in a CI cell: every privacy parity case must still pass, which proves the store and TypeScript agree. | Touches visibility members: after the swap only. | After Dec 4; needs decision P first. |
| G9 | Split the tests that bake in one writer into an embedded variant and a pending multi-writer twin (list in "Tests to write now"). | tests | about 250 | Twins are pending. | Embedded assertions stay; names change to say "embedded, one owner". | Renames touch test files swap branches edit; after the swap. | Dec 2 or later. |
| G10 | Bounded waits. The optimistic store's key-lock wait ends at the caller's deadline with `timeout` (audit row A9); an explicit transaction gets a wrapper deadline that rolls it back (A2). | dark code | about 100 | Key-lock wait: only on the opt-in optimistic store. Transaction deadline: `GBRAIN_RUST_TXN_DEADLINE_MS`, unset by default. | Off: no timer exists. | Small; after the swap. | Dec 3 or later. |
| G11 | Owner-side remote check. The owner applies `OWNER_IPC_REMOTE_READS` itself to frames marked remote, instead of trusting the client to (audit row B2). | dark code | about 70 | `GBRAIN_RUST_OWNER_REMOTE_CHECK=1`, default off. | Off: unchanged. On: the remote-caller tests pass unchanged, since the client already refuses first. | Owner socket: after the swap. | Dec 4 or later. |
| G12 | Small cleanups: the process-wide vector cache moves onto `Store` (A10); the comments in A14 say "while explicit transactions hold the writer". | cleanup | about 60 | No flag: same results; the 64 MiB bound becomes per store. | Unchanged answers; vector cache tests. | None; after the swap. | Ride with G1. |

Not on the list on purpose: a scope type threaded through every store entry point (L, it is M2 work
and needs the maintainer's yes for M2); several processes opening the store files (ruled out by the
prior-art map); a hybrid logical clock (not needed with one primary).

## Tests to write now

The rule from the prior-art map: the systems with the best records wrote the test harness first. These
tests can be written now. They run today on Postgres, on PGLite where its single connection can express
the case (which proves each test is right), and on the single-writer Rust store where the guarantee
already holds; the multi-writer cases are pending
until a multi-writer mode exists.

### 1. Multi-writer conformance suite

Files: `rust/crates/gbrain-store/tests/multi_writer_conformance.rs` (store level, about 420 lines) and
`test/engine-parity/multi-writer-conformance.test.ts` (engine interface, about 380 lines).

How pending works:

- Rust: each pending case is `#[ignore = "multi_writer"]` and runs with
  `cargo test -- --ignored multi_writer`. The precedent is `tests/occ_history.rs:716-717`. CI does not
  run ignored tests today (`.github/workflows/rust-engine.yml:214`), so the cases cost nothing until a
  cell turns them on.
- Parity harness: add `multi_writer` to `EngineCapability` (`test/engine-parity/arm-capabilities.ts:32`).
  PGLite and Postgres have it; Rust does not. It must skip the Rust arm (`n/a`), not expect a refusal:
  today `missingCapability` (`arm-capabilities.ts:41-47`) returns `refuses` for every capability but
  `schema_migration_lock`, and a `refuses` case would assert `engine_capability_missing`, which is wrong
  for a feature that is not built. The skip path already exists (`harness.ts:685-686`) and the tally's
  sum check counts skipped cases (`rust-tally.ts:70`). The arm table is hard-coded by arm name
  (`arm-capabilities.ts:50-61`), so when Rust gains the capability, one line in that table turns the
  cases on for its arm; no case changes. PGLite runs one connection (`src/core/pglite-engine.ts:1384-1387`),
  so cases that need two open transactions at once are not applicable on its arm.
- Template for the shape of a case: `test/engine-parity/jobs.test.ts:330-354` ("claimNextJob from eight
  workers at once ... hands each job to exactly one worker"), which compares outcomes, not the order the
  engines took.

| Case | Typed operation (D20 table) | Invariant | Today on PGLite and Postgres | Today on Rust (single writer) |
|---|---|---|---|---|
| C01 same-page writers lose no update | compare-and-set page write | every acknowledged write is in the history, or it got a typed `revision_conflict` | runs | runs (`concurrency.rs:64` shape) |
| C02 stale revision gets a typed conflict | `upsert_chunks` with expected revision | stale writer gets `revision_conflict`, a re-read succeeds | runs | runs |
| C03 two claimers of one write never both claim | `claim_next_writes` | one claimant per request at a time | runs | runs for unbound writes (served through the typed persistence members); managed and cross-host cases pending |
| C04 eight workers claim each job once | `claim_next_job` | no double claim, none lost | runs | runs (`tests/jobs.rs:74-124`) |
| C05 expired claim is reclaimed once | `reclaim_stalled_jobs`, `renew_job_lease` | reclaimed once; renewal with the old token refused | runs | partly; concurrent reclaim pending |
| C06 stale holder's data write refused by its token | `acquire_lease`, `assert_lease` in the writing transaction | a paused holder cannot write protected data after a takeover | to write: the existing tests guard only the lease row's renewal and release (`drain-lease-guards.test.ts:68-83`) | to write: `jobs_drain_lease.rs:119-151` covers lease-row renewal and token-scoped release only |
| C07 effect claimed once, rerun after owner crash | `claim_effects` | one claimant; a crash between action and record lets it run again; no duplicate row | runs | pending |
| C08 counter never over-admits | `reserve_capacity` | no over-admission, no lost update | runs | runs (`concurrency.rs:233-270`) |
| C09 idempotency key maps to one row | `admit_job` | concurrent submits of one key give one row | runs | to write: job admission is tested only one submit at a time (`tests/jobs.rs:183-193`); `concurrency.rs:209-229` is the same shape for page writes |
| C10 facts of one entity form one total order | `append_fact` | one stable order per entity, no lost fact | runs | pending (concurrent appends) |
| C11 per-entity order equals commit order | `append_fact` with a sequence assigned at commit | the order a reader sees is commit order | not today: SQL reads order facts by `created_at, id` (`src/core/engine-sql/facts.ts:496-518`), which is not commit order; this case defines the new, stronger rule | pending |
| C12 two transactions read only their own writes | `transaction(fn)` | each reads its own uncommitted writes, never the other's | runs (`transaction-settings.test.ts:99-111`) | runs; also run on the optimistic store |
| C13 transactions on different keys do not wait | `transaction(fn)` | a commit on another key lands while a transaction is open | runs on Postgres (row locks); not applicable on PGLite (one connection, a second transaction queues: `test/pglite-checkpoint-guard.test.ts:193-207`) | pending: today it waits (`concurrency.rs:359`) |
| C14 concurrent publishers, one winner | `publish_generation` | generations monotonic; never two winners | runs | pending |
| C15 single flight holds only its keys | `single_flight(keys)` | sorted keys, released at commit or abort, never two holders | runs (`page-lock-anchors` tests) | partly |
| C16 format upgrade runs once under concurrent openers | `upgrade_format` | exactly one upgrade; callers see old or new, never partial | partly | partly (single open only) |
| C17 a second opener becomes a client, never an error | `open_brain` | no busy error; calls in flight retry by request id | no (PGLite refuses by design) | pending |
| C18 64 writers in 8 processes, no busy error | all rows; the plan's stress cell | no lost update, no double claim, no busy error | partly | pending (16 clients through the owner today, `rust-owner-clients.test.ts`) |
| C19 crash after commit keeps acknowledged writes | crash robot | acknowledged writes present, none duplicated | runs | partly (`sim.rs`, `occ_history.rs:595`) |
| C20 no deadlock across two pages in both orders | sorted keys, compare-and-set | no deadlock | runs | partly (no locks to deadlock today) |
| C21 read-your-writes token on a second connection | commit position as a token | a write acknowledged on connection A is seen by B given the token | plain read-after-commit runs on Postgres; no engine has a token today (`transaction` returns the callback's value, `src/core/engine.ts:1099-1101`) | pending (needs G5 or G7 and an interface change) |
| C22 commit position strictly increases | commit log | no two commits share a position; positions only grow | partly | partly (batches share one today, audit row A6) |

### 2. Concurrency and ordering property tests

File locations: `rust/crates/gbrain-store/tests/multi_writer_props.rs` (proptest, about 300 lines, same
`failure_persistence: None` setting as `tests/store_props.rs:37-42` so a run writes no files) and
`rust/crates/gbrain-store/tests/multi_writer_sim.rs` (seeded simulation, about 260 lines).

| Property | Tool | Runs today |
|---|---|---|
| P-A Any generated interleaving, replayed in commit order, reproduces every read (serializable) | `gbrain_sim::check::check_serializable` (`check.rs:145`) with the seeded `Scheduler` | on the single-writer store; on the optimistic store only with OS threads (`occ_history.rs`), so not reproducible by seed. Deterministic scheduling is decision Q. |
| P-B Facts of one entity read back in commit order | proptest | pending |
| P-C Commit positions strictly increase on any store; by exactly one per commit only on the single-writer store | proptest | yes on single writer |
| P-D After lease B is granted, any write with lease A's token is refused in its own transaction | proptest | partly: today's tests cover the lease row only (`jobs_drain_lease.rs:119-151`), not a protected data write |
| P-E A read with a write's token sees that write | proptest | pending (needs G5 or G7) |
| P-F Admission never exceeds a cap under any generated arrival order | proptest | yes (generate the sizes `concurrency.rs:233` fixes) |
| P-G Any number of replays of one request id leaves one row | proptest | yes (generate the count `concurrency.rs:209` fixes) |
| P-H A crash at any generated point keeps every acknowledged commit and the in-doubt batch whole | `check_recovery` (`check.rs:271`) | yes (`sim.rs:1149`; optimistic variant `occ_history.rs:595`) |

A TLA+ model of claim, fence and reclaim (`spec/tla/claim-lease/`, about 200 lines) is optional. Only
the drain-lease and refresh-barrier specs exist today.

### 3. Current tests that bake in a single writer

Verdicts: **split** keeps the embedded assertion as a named "embedded, one owner" test and adds a
pending multi-writer twin; **change** means the assertion is wrong once writers overlap; **valid** stays
true. All at trunk `3e79ea5896`.

| Test | What it assumes | Verdict |
|---|---|---|
| `rust/crates/gbrain-store/tests/lifecycle.rs:38-46` | a second open of a live brain fails `store_locked` | split (server: the second opener is a client) |
| `tests/read_only.rs:118-141` | a read-only open beside a writer fails `store_locked` | split |
| `tests/concurrency.rs:349-370` | another commit cannot land while an explicit transaction is open | change: split into "same key conflicts or waits" and C13 "other keys proceed" |
| `tests/concurrency.rs:311-324` | an explicit transaction never conflicts | change: conflicts become typed and visible |
| `tests/concurrency.rs:332-345` | after the writers finish, a fresh id is greater than every id handed out | valid: it guards against reuse, not completion order |
| `tests/transactions.rs:39-50`, `tests/entity_identities.rs:75-84`, `tests/lifecycle.rs:506-511` | one isolated operation advances `commit_version` by exactly one | valid: each runs alone; add separate tests for overlapping commits |
| `tests/occ_history.rs:502-510`, `:923-929`; `tests/sim.rs:1038` | one isolated write after recovery gets exactly `version + 1` | valid: one commit alone; keep |
| `tests/sim.rs:45`, `:71`, `:595` | the seeded simulation drives only the single-writer store | split: add an optimistic-store variant (decision Q) |
| `src/write_trust.rs:340-366` | a second transaction cannot begin while the first is open | change |
| `src/transactions.rs:564-571` | one explicit transaction per store handle, on the exclusive writer | split: one transaction per connection |
| `tests/common/mod.rs:38-47` | the default opener is single-writer unless an environment flag is set, and CI never sets it | change (G3) |
| `src/access_flag.rs:422` | lists every raw write handle; a new multi-writer handle must be added | valid, list grows |
| `test/rust-engine-store.test.ts:93-106` | a second engine becomes a client, then opens the store when the first closes | split |
| `test/rust-owner-ipc.test.ts:119-158`, `:166-190` | a second process is a client; exactly one owner | split |
| `test/rust-owner-ipc.test.ts:797-840` | calls after a takeover share one election | split |
| `test/rust-owner-failover.test.ts:89-119`, `:149-151` | exactly one survivor owns the brain | split (M4 failover is a fenced primary) |
| `test/rust-owner-clients.test.ts:30-36` | one owner plus sixteen client processes | split: multi-writer twin asserts no busy error and every page present |
| `test/rust-engine-lock-owner.serial.test.ts:29-54` | the serve that holds the lock names itself | split |
| `test/rust-owner-ipc-limits.test.ts:80-91`, `:156-166`, `:291-301` | the owner refuses past its caps with `owner_busy` | split; see decision R |
| `test/rust-owner-ipc-remote-mark-tools.test.ts:318`, `:337` | a transaction or whole operation from a second process is refused | change (the server needs it) |
| `test/persistence-consumer-election.test.ts:247-258` | a forced sync consumer beside a live serving consumer on the same host logs `two_consumers_on_host` | valid: the plan keeps one full consumer per host (`docs/designs/RUST_ENGINE.md` D20 table); many writers do not need many full consumers |
| `test/db-lock-election.test.ts:46-57` | one holder per tick through the token-fenced cycle lease (`src/core/db-lock.ts:249-260`) | valid; keep |
| `test/rust-owner-ipc.test.ts:1419`, `:1434` | a second process never sees `store_locked`, `pglite_busy` or `owner_unavailable` | valid; keep as a multi-writer assertion |
| `test/engine-parity/jobs.test.ts:330-354`, `transaction-settings.test.ts:99-111`, `write-request-cancel.test.ts:106`; `rust/crates/gbrain-store/tests/jobs.rs:74-124`, `tests/oauth_clients.rs:336-349` | outcome-only concurrency checks | valid; templates for the suite |

Sampled, not complete: the black-box CLI tests, the crash robot under `scripts/persistence/` and most
of the 387 parity files were not read for this list.

## Open decisions

The groundwork items G1 to G12 each wait for the maintainer's pick. These design questions are open
too. None blocks Dec 1, and none needs an answer before the server phases start, except P (before G8)
and Q (before G6's optimistic-store part).

- **M. Which process is the M1 server.** Options: 1) `gbrain serve` hosts the in-process addon and the
  wire carries `BrainEngine` calls, as the owner socket does today; 2) a native Rust server binary, with
  the TypeScript operations only on clients. Recommendation 1: operations, the persistence coordinator
  and the error contract are TypeScript and must stay byte-identical, and the owner socket is already
  most of the protocol. The Store API seam keeps 2 open.
- **N. Interactive transactions over the wire in M1.** Options: 1) whole operations only first; 2)
  interactive transactions from the start. Recommendation 1: with today's exclusive transactions a slow
  remote client would stop every commit; interactive transactions come with optimistic explicit
  transactions.
- **O. Policy engine for M2.** Options: 1) keep gbrain's hand-written access checks in `gbrain-store`;
  2) put the decision in Cedar. Recommendation 1 through M2, because the parity suite proves the hand
  checks today; revisit Cedar for delegation tokens.
- **P. Where the access policy is derived.** Options: 1) the store derives it from an identity handle,
  starting with the G8 self-check; 2) TypeScript keeps rendering it and the server only authenticates.
  Recommendation 1: a server cannot trust a policy a client rendered (audit rows B1, B3, A12).
- **Q. Deterministic scheduling for the optimistic store.** Options: 1) drive `OccKv` transactions as
  tasks on the existing `gbrain-sim` scheduler (no new dependency); 2) add `shuttle` or `loom` (new
  dev dependency, named by the prior-art map). Recommendation 1 first, because it reuses the seeded
  disk faults and checkers; add `loom` only for the small lock-free parts if a bug calls for it.
- **R. Owner caps against "no busy error".** The owner refuses past its caps with `owner_busy`
  (`test/rust-owner-ipc-limits.test.ts`); D20 says a second process never gets a busy error.
  Options: 1) keep the caps, and have the client retry `owner_busy` inside the caller's deadline, so a
  caller sees `timeout` only when its own deadline passes; 2) queue without a bound. Recommendation 1:
  bounded memory stays, and no caller sees a busy error before its deadline.
- **S. Commit log shape.** Options: 1) logical records (changed keys and operations) with a size cap,
  and a snapshot install for a follower past the cap; 2) physical page shipping from redb.
  Recommendation 1: it does not tie the format to redb's file layout, which the bake-off may replace.

## Appendix: lock skips that rely on one writer

Found by searching trunk `3e79ea5896` for comments that name the single writer ("one write transaction at a time", "one writer", "single writer", "writer gate", "holds the writer", "no other writer"), then reading each hit and dropping the ones about other locks. A skip with no such comment is not found this way, so the list is a floor, not a census. One more site is on an unmerged branch: `src/commands/agent-register.ts:546` on `rust-engine/client-grant-write-rust` (`9725bb8c89`).

- `rust/crates/gbrain-store/src/access_policy.rs:7`
- `rust/crates/gbrain-store/src/chronicle_state.rs:224`
- `rust/crates/gbrain-store/src/dream_config.rs:8`
- `rust/crates/gbrain-store/src/eval_capture/decide_proposals.rs:32`
- `rust/crates/gbrain-store/src/facts/cycle.rs:583`
- `rust/crates/gbrain-store/src/facts/loops.rs:649`
- `rust/crates/gbrain-store/src/facts/purge_writes.rs:17`
- `rust/crates/gbrain-store/src/facts/reconcile.rs:14`
- `rust/crates/gbrain-store/src/facts/write_path.rs:17`
- `rust/crates/gbrain-store/src/import_members.rs:10`
- `rust/crates/gbrain-store/src/jobs.rs:55`
- `rust/crates/gbrain-store/src/jobs/access_tokens.rs:410`
- `rust/crates/gbrain-store/src/jobs/credential_binding.rs:14`
- `rust/crates/gbrain-store/src/mention_state.rs:13`
- `rust/crates/gbrain-store/src/page_body/derivation_sweep.rs:21`
- `rust/crates/gbrain-store/src/pages.rs:1626`
- `rust/crates/gbrain-store/src/persistence.rs:45`
- `rust/crates/gbrain-store/src/persistence/noop_settle.rs:7`
- `rust/crates/gbrain-store/src/takes/held.rs:9`
- `rust/crates/gbrain-store/src/timeline/held.rs:9`
- `rust/crates/gbrain-store/src/transactions.rs:32`
- `rust/crates/gbrain-store/src/trust/held_rows.rs:9`
- `rust/crates/gbrain-store/src/trust/proposals.rs:22`
- `rust/crates/gbrain-store/src/write_guards.rs:12`
- `rust/crates/gbrain-store/src/write_misc.rs:89`
- `src/core/belief/coverage.ts:33`
- `src/core/engine-sql/oauth-clients.ts:219`
- `src/core/engine-sql/page-purge.ts:156`
- `src/core/engine-sql/publication-journal.ts:13`
- `src/core/engine-sql/writer-admin.ts:27`
- `src/core/output/writer.ts:159`
- `src/core/persistence/managed-mode.ts:70`
- `src/core/persistence/skill-activation.ts:37` (the reviewed shared-skill activation: its `--expected-state` re-check and the activation write share one explicit transaction)
- `src/core/rust-engine/store-members/access-grants.ts:23`
- `src/core/rust-engine/store-members/access-members.ts:174`
- `src/core/rust-engine/store-members/access-policy.ts:23`
- `src/core/rust-engine/store-members/cli-sources.ts:97`
- `src/core/rust-engine/store-members/dream-config.ts:6`
- `src/core/rust-engine/store-members/effect-worker.ts:53`
- `src/core/rust-engine/store-members/facts-purge.ts:8`
- `src/core/rust-engine/store-members/facts-rest.ts:47`
- `src/core/rust-engine/store-members/facts-write-path.ts:9`
- `src/core/rust-engine/store-members/fence-holds.ts:8`
- `src/core/rust-engine/store-members/import-members.ts:7`
- `src/core/rust-engine/store-members/jobs-access-tokens.ts:61`
- `src/core/rust-engine/store-members/jobs-client-grants.ts:5`
- `src/core/rust-engine/store-members/jobs.ts:84`
- `src/core/rust-engine/store-members/page-purge-journal.ts:8`
- `src/core/rust-engine/store-members/page-purge-sweep.ts:13`
- `src/core/rust-engine/store-members/page-purge.ts:12`
- `src/core/rust-engine/store-members/persistence.ts:46`
- `src/core/rust-engine/store-members/shared-skill-members.ts:18`
- `src/core/rust-engine/store-members/transactions.ts:6`
- `src/core/rust-engine/store-members/trust-fence.ts:16`
- `src/core/rust-engine/store-members/worktree-claim.ts:8`
- `src/core/rust-engine/store-members/write-guards.ts:55`
- `src/core/rust-engine/store-members/write-misc.ts:27`
- `src/core/rust-engine/store-members/writer-release.ts:9`
