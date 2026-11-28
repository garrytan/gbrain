# The brain store: Commit positions, the commit log and write origin

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Multi-user mode only (interface I-0 to I-4 of the multi-user build, `docs/designs/rust-engine/multi-user-server.md`,
"Write journal and store format changes"). Code: `crates/gbrain-store/src/commit_log.rs`, the writers in
`redb_kv.rs` (single-writer store) and `occ_kv.rs` (the optimistic pipeline), the open in `lib.rs`.

## Switches

| Switch | What it turns on | Read |
|---|---|---|
| `GBRAIN_RUST_MULTIUSER=1`, or the brain's config row `engine.rust.multiuser` = `true`/`1` | Multi-user mode (`OpenOptions::multiuser`, `src/core/rust-engine/multiuser-switch.ts`) | the caller resolves the variable, the store reads the row at open |
| `GBRAIN_RUST_COMMIT_LOG=1` | The commit log (`MultiUserWrites::commit_log`) | only while the store resolves multi-user mode on |
| `GBRAIN_RUST_WRITE_ORIGIN=1` | Write origin on journal rows (`MultiUserWrites::write_origin`) | only while the store resolves multi-user mode on |

Off (the default for all three), nothing on this page happens: no key under tag `2` is written, `M\0ctime` is never
written, `FORMAT` and the format record keep their bytes, journal rows keep their `extra`, the open result keeps its
shape and no clock or id is drawn that was not drawn before. Commit positions are computed either way, and nothing an
agent sees shows them. Sub-switches set while multi-user mode is off are ignored.

## Commit positions

`CommitPosition { sequence: u64, index: u32 }`, ordered by `(sequence, index)`; JSON `{ "sequence": n, "index": n }`;
read token `cp1:<sequence>.<index>`.

```
single-writer store        optimistic store (one group commit = one redb commit)
seq 41  (41,0)             seq 41  (41,0) (41,1) (41,2)     <- accepted, in accept order
seq 42  (42,0)             seq 42  (42,0)                   a refused transaction gets no position
```

- A commit that reaches the record file gets a new position: `(sequence, 0)` on the single-writer store (every
  commit there bumps the sequence, an empty one too), `(sequence, i)` for the i-th accepted transaction of a group
  commit on the optimistic store.
- A completion that commits nothing (an optimistic transaction with no writes, a transaction opened read-only)
  returns `CommitPosition::end_of(snapshot sequence)` = `(sequence, u32::MAX)`: after every commit of that batch and
  before `(sequence + 1, 0)`, so a position never goes backwards and works as a read-your-writes token.
- `KvWrite::commit()` still returns the sequence (`commit_position().sequence`); `Store::commit_transaction_at`
  and napi `commitTransaction` return the position.

## Commit times and the accept hook

While multi-user mode is on (with the log on or off), every accepted transaction gets a commit time:
`max(store clock, previous accepted commit time + 1 µs)`, microseconds since the Unix epoch, UTC. Commit times
strictly increase in commit-position order, inside a group commit too, even when the clock goes back. The same
record-file commit writes the newest one to the adapter key `M\0ctime` (8 bytes big-endian, reserved like the
commit sequence) and, with the log on, each transaction's own time into its commit record, so a time is durable
exactly when its data is and a failed commit leaves none behind. `Store::last_commit_time()` reads `M\0ctime`: the
floor at open, for a restart or another process opening the store. A store rebuilt from the log takes the floor
from its newest record (`commit_log::floor_time`); a store snapshot (`Store::snapshot_to`) carries `M\0ctime` over
from the same pinned state. The time of a commit that fails is not kept: the next commit may take it again (the
accept hook is for observation and may have seen it). Commit times set row times and the clock floor; every
"what happened first" rule uses the commit position, never the time.

`Store::set_accept_hook(hook)` (multi-user mode only; refused while off) is for observation: the record file's one
writer calls `hook(Accepted { position, commit_time })` once per accepted transaction, in commit order, at the accept
step (the pipeline's accept loop, or the single-writer commit under redb's write lock), with the same commit time the
record carries. It runs before the commit is durable, so it may see a commit that then fails.

## The log

Keys under tag `2` (declared in `commit_log.rs`, claimed in the tag registry of
`docs/designs/RUST_ENGINE_INTERFACES.md`):

- `2`: the meta record, JSON `{ since, newest, trimmed_through }`. `since` is the activation commit, `newest` the
  newest commit with a record (`since` before the first), `trimmed_through` the newest record retention removed.
- `2 sequence_be8 index_be4`: one commit record, version 2 (I-4.v2). Value (all lengths and counts u32 big-endian):
  `[version u8 = 2]` `[host id, incarnation, writer id: each length-prefixed UTF-8]`
  `[commit time: i64 big-endian, microseconds since the Unix epoch, UTC]`
  `[count of write ids, each length-prefixed]` `[count of ops; each: op u8, key length-prefixed, operand length-prefixed]`.
  Ops: `1` put (operand: the full value, never a reference), `2` delete (empty operand), `3` `add_i64` (the delta, 8
  bytes little-endian, as counters are stored), `4` `raise_counter` (the value, 8 bytes big-endian, as id sequences
  are stored). One op per key, keys in increasing order. A version other than 2 (version 1 was retired before any
store outside tests held it) refuses with `format_unknown`; any other malformed record with `store_corrupt`. Where a
record is decoded to JSON it carries `"commit_time_us"`.

What a record holds:

- Optimistic store: the transaction's own buffered writes, exactly (`put`, `delete`, `add_i64`, `raise_counter`).
  A follower applies records in `(sequence, index)` order, which is the order the pipeline resolved them.
- Single-writer store: the final value or delete of each key the commit wrote; an id sequence the commit only raised
  is logged as `raise_counter` (replayed as a max).
- A rolled-back or dropped explicit transaction leaves no data in the log: its writes are dropped uncommitted, and
  the commit that carries its id sequences forward holds `raise_counter` ops and nothing else.
- An abandoned explicit transaction (rolled back, dropped, or a run whose commit was refused) leaves at most one
  record, and only when it took ids: that one record of `raise_counter` ops is intended. It is how a follower learns
  the ids the abandoned run handed out, so a follower that takes over as primary never hands them out again (ids
  stay unique across a failover). One that took no id leaves no record. Pinned by
  `tests/commit_log.rs::an_abandoned_transaction_logs_one_counter_record_only_when_it_took_ids` on both stores.
- Origin: the open's host id and incarnation (a UUID v7 per open), and the writer `<principal_kind>:<principal_id>`
  from the write trust context or the first journal request the write admitted; empty when unknown. Write ids: the
  persistence request ids the write admitted or ran for. Inside an explicit transaction they belong to the statement
  layer: a failed statement or a rolled-back savepoint drops them, and a rollback that writes id sequences forward
  commits with none.

Every commit since `since` has a record, in the same redb write transaction as its data, on both stores: no record
exists without its data and no data without its record. The one unlogged commit after activation is none: the open
enables the log before any of its own upkeep writes (format upgrades, the source-index backfill, the keyword index
reset, the access-flag scan), so those are logged too.

`Store::read_commit_log(after, max) -> LogPage { records, oldest_retained, newest, snapshot_required }` reads one
snapshot. `after = None` reads from `since`. `snapshot_required` is true, with no records, when `after` is older than
`since`, older than `trimmed_through`, or past `newest`: the reader must install a snapshot first. The records carry
every key family, so this read is internal to the store and its tests.

## Retention

Hard cap: `retention_bytes` of records (keys plus values, 64 MiB by default). A commit that appends trims the oldest
records until the rest fit, in its own redb commit, and may trim every record, its own included. The meta record keeps
`newest` and `trimmed_through`, so after a full trim and a restart the cursor rules above still hold. No write is
refused for the cap.

## Store format 16 and activation

A brain opened with the log becomes store format 16 (`format::LOG_FORMAT_VERSION`, registry row `opt-in` in
[format.md](format.md)). Its records stay a base format's shapes; the format record keeps the base as
`log.base_format` and `log.since`, and `FORMAT` carries `"log": { "since": ... }`.

```
open with the log on, brain not yet logged:
  base upgrade (unlogged) -> FORMAT stamped 16 + log.since
  -> one exclusive write: format record 16 + meta record (its position is since)
  -> log enabled -> upkeep writes (logged) -> FORMAT written from the records
open of a format-16 brain:
  log on:  enable the log -> base upgrade from log.base_format (logged, keeps 16) -> upkeep (logged)
  log off, writable: refused (format_unknown, names GBRAIN_RUST_MULTIUSER=1), before the record file is opened
  read-only: opens; nothing is written
```

A build without the log refuses a format-16 brain as newer, with and without `FORMAT`, and changes no byte. A crash
after the `FORMAT` stamp and before the records leaves a brain this build finishes with the log on and refuses without
it. A base newer than this build reads is refused.

## Write origin on journal rows

With write origin on, the native admission (`admit_write`, `submit_page_mutation`) and the compatibility path
(`insert_write_request`, `insert_write_request_group`) put into the request record's `extra`: `admitter_host_id`
(the open's host id, unless the caller gave one; an admission's `origin.hostId` overrides it), `admitter_incarnation`
(the open's, or `origin.incarnation`) and `writer_id`. The row the members return shows `admitter_host_id` in its
existing column; the other two are not in any row. Off, `origin` on an admission is ignored and `extra` is unchanged.

## Engine members

`BrainEngine.readCommitLog(after, limit)` and `BrainEngine.lastCommitPosition()` (src/core/engine-members/commit-log.ts)
expose the log and commit positions to TypeScript, through the addon's `Brain#readCommitLog` and
`Brain#lastCommitPosition` (`gbrain-napi/src/families/commit_log.rs`). A page lists each record's position, commit time,
origin, write ids and op count (the ops stay in the store). `lastCommitPosition` on the engine answers the newest
finished write or transaction of that engine; on the engine a transaction callback received, the position that
transaction committed at, also after it ended (null while open or after a rollback). Both refuse with
`engine_capability_missing`, reason `commit_log`, on PGLite and Postgres and on a Rust engine whose store keeps no log;
the Rust engine reports the `commit_log` capability only while its store keeps one. Positions cross as JavaScript
numbers; a sequence of 2^53 or more or an index above 2^32 - 1 is refused, never truncated.

## Followers and promotion

`gbrain_store::follower::Follower` (`follower.rs`) keeps a copy of a commit log brain from its primary's log. It is a
replica of the whole brain, log included: the primary's records (with its own retention), commit sequence and durable
commit time. Its cursor is its own log's `newest`, written in the same redb transaction as the data it applied.

| Call | What it does |
|---|---|
| `Follower::open(dir)` | Opens or creates the follower in `dir`; an empty one accepts only a snapshot. A brain without a log is refused. |
| `apply_page(&LogPage)` / `apply_raw(lineage, &[(position, record bytes)])` | Applies the records after the cursor in one redb transaction: data ops, the records, the log meta, the sequence (pinned to the primary's) and `M\0ctime`. Records at or before the cursor are skipped, so applying twice is a no-op. A gap, a cursor the log no longer reaches, or another history refuses `snapshot_required` and changes nothing; holding records past another timeline's fork refuses `diverged_tail` (below). |
| `install_snapshot(dir, manifest)` | Validates and copies a snapshot (`Store::snapshot_to`) from one held read state, in one redb transaction that replaces every key. Refused, changing nothing: no log, another brain, a manifest mismatch, an inconsistent log, or a snapshot behind the follower on the same history. On another history it may move the follower back, but only over an exported diverged tail (below). |
| `cursor()`, `lineage()`, `sequence()`, `last_commit_time()`, `records()` | What the follower holds. |
| `promote(options)` / `promote_with(options, env, settings, stopped)` | Fenced (below), then starts a new timeline at the cursor and opens the brain as a logged multi-user `Store` on `env`. The new timeline's first commit, `(cursor.sequence + 1, 0)`, is its promotion note (`M promotion/<timeline>`: who promoted, from where, on what basis); its commit clock starts above max(`M\0ctime`, the newest record's time). A refusal changes nothing; an error after the new timeline is written is `promotion_partial` (open the brain with `Store::open_dir`, then `serve_as_primary`). |

History: the log meta keeps `lineage`, the timelines `{ id, from }` the log went through after its first one (absent
until a promotion). Every `LogPage` carries it. A follower continues only when its own lineage is a prefix of the
page's and every newer timeline starts at or after its cursor (`commit_log::lineage_continues`). Cost: a snapshot
install is one redb transaction the size of the brain.

### The promotion fence and the primary's write fence

A primary serves under the lease `primary` (lane L5's leases, `takeover::PRIMARY_LEASE`): `Store::serve_as_primary`
takes it and arms the store's write fence (`primary.rs`), `renew_primary` renews it and `release_primary` hands it over.
While armed, every write of the store, its bound transactions and its builder reads the lease inside its own write
transaction, and the record file accepts the commit only while its commit time is before the lease's end
(`commit_log::CommitFence`, checked in the pipeline's batch write after its conflict checks, and in the single-writer
commit). A transaction's commit reads the lease again inside the commit, whatever its statements saw; an optimistic
one whose snapshot predates the lease it would commit under conflicts and runs again. The id-sequence write of a
refused or rolled-back transaction carries the fence, and is skipped when the store must not write. A logged store that
never served reads the lease record in every write, so a lease taken while one of its commits is in flight makes that
commit conflict. So a primary whose
lease lapsed, was released or was taken over is refused `lease_lost` at commit and writes nothing. A store opened on
records that hold a primary lease refuses writes (`lease_lost`, reason `primary_not_served`) until it serves, and its
open writes nothing: the open-time upkeep (sweep-record index backfill, keyword index repair and build) runs in
`serve_as_primary` after it takes the lease, each upkeep commit under the lease's fence, and an open that would upgrade
the format or switch the brain to the log is refused with the same reason. A serve that fails after it took the lease
hands the lease back and leaves the store refusing writes. A transaction's store cannot hand the lease over
(`invalid_state`). A store whose records never held one is never fenced.

Only the concurrent record store serves as a primary: `serve_as_primary` (and so a takeover) refuses the single-writer
adapter with `invalid_state`, naming `GBRAIN_RUST_CONCURRENT_WRITES=1` or multi-user mode, and writes no lease. On the
single-writer adapter, ids a refused or rolled-back transaction took are not durably reserved; that is safe only
because that adapter never serves as a primary, which
`tests/takeover.rs::the_single_writer_store_never_serves_as_primary_and_writes_no_lease` enforces. Multi-user mode
already opens a brain directory on the concurrent store.

Open cases of the write fence: a fail-closed open leaves the access flag scan unstored (it judges the flag from a
read, as an open that cannot write does); and a brain that holds a primary lease and needs a format upgrade opens only
read-only.

The lease record replicates with the data, and a promotion judges it on the promoting machine's clock:

| The old primary's lease, as the follower holds it | Promotion |
|---|---|
| released (a clean hand-over) | promotes at once |
| live | refused `primary_live` |
| lapsed and not released, or no primary lease | refused `primary_unconfirmed`, unless the caller passes `OldPrimaryStopped` |
| lapsed, with `OldPrimaryStopped` | refused `primary_live` until the lease's end plus `TakeoverSettings::margin_ms` (default `DEFAULT_TAKEOVER_MARGIN_MS`, 2 000), then promotes; the promotion note records the reason |

A lapse alone proves nothing: the old primary may have renewed in a commit the follower never applied. Only the caller
knows the old primary stopped, so nothing builds `OldPrimaryStopped` on its own, and no napi, TypeScript or CLI path
reaches a promotion (guarded by `tests/takeover.rs`). Not covered: clock skew larger than the margin; and two
primaries after a wrong attestation during a network cut, or after two followers both promote, which is phase M4
(work item 9e3753d4).

## Replica acks

With multi-user mode on, a primary can wait for a follower before it answers a write (`replica.rs`, the TypeScript
gate `served/replica-gate.ts`). The guarantee holds only for the follower the primary waited for: an answered write
is in the records of every attached replica that acked it, so an attested promotion of that replica keeps it. Writes
made in-process on the server (not through a served connection) never wait. A brain with no attached replica answers
as before, with no store call.

| Call | What it does |
|---|---|
| `Store::attach_replica(id)` | Records `M replica/<id>` (`{ id, generation, attached_at_us }`) in a logged commit. Idempotent; a re-attach after a detach takes the detach's generation + 1. An id is 1-128 of letters, digits, `.`, `_`, `:`, `-`. |
| `Store::report_replica_ack(id, generation, cursor, lineage)` | Raises the replica's acked cursor in memory, never back. Refused `invalid_state`, changing nothing: an id not attached, another generation, a cursor past the log's newest, or a lineage the log does not continue. |
| `Store::replica_cover(position)` | `{ required, covered, acked_through }`: required while any replica is attached; covered when one acked at or past `position`. |
| `Store::wait_replicated(position)` | Waits (bounded) until covered; ends `replication_timeout` on its deadline, a full budget, or a detach. Not on napi: the served gate waits in TypeScript and holds no pool worker. |
| `Store::detach_replica(id, reason)` | Deletes `M replica/<id>` and writes `M replica-detach/<id>` in one logged commit; false, committing nothing, for an id not attached. Ends every wait at once. |

A follower names its replica id in `repl_follow` (`followPrimary({ replica })`). The primary attaches it and counts
only acks that can be true: a records ack that is `ok`, answers the frame sent and ends at its last record; a snapshot
ack at the snapshot's commit sequence (the manifest `generation`); and, on reconnect, the follower's cursor with a
lineage the store accepts. Each counted ack is told back as `repl_mark { acked }`, which the follower keeps durably in
`REPLICA-MARK` (`Follower::note_primary_acked`); a promotion records it as `acked_seen` in its note. A promotion
detaches every replica the brain had attached, reason `promoted <timeline>`, in the note's commit. Acks are in memory:
a restarted primary waits again until the follower reports.

| Setting | Default | Range |
|---|---|---|
| `GBRAIN_RUST_REPLICA_ACK_TIMEOUT_MS` | 10 000 | 1 to 600 000 |
| `GBRAIN_RUST_REPLICA_ACK_MAX_WAITERS` | 1 024 | 1 to 65 536 |

The store reads both at open, only with the commit log on; any other value refuses the open `invalid_argument`. The
TypeScript engine sends its own process's values (`OpenOptions::replica_ack_env`); a name it does not send is read
from the store process's environment.

A served write that does not see its ack in time ends `replication_timeout` (reason `outcome_unknown`): the commit is
durable on the primary, and only the replica's copy is unknown. Do not send a new write: resend the same request id,
which answers once the ack arrives, or the timeout again. With `max_waiters` answers already waiting, a new write is
refused `replication_busy` before it runs (nothing written; retry). Reads never wait. The `replica/` and
`replica-detach/` keys are read only by name (`replica.rs`); no list, dump, export or parity path scans the meta
family, so no output shows them. Snapshots and the log carry them as brain data. Switched off, the store writes none.

Detach runbook (a replica that is gone, so writes stop timing out): on any machine with an owner server token, call
`followPrimary(...).detach(reason)` on the replica's own link, or `detachReplicaAt({ url, token, ca, replica, reason })`
from `served/follower-serve.ts` (one connection, `repl_detach`, answered `repl_detached { detached }`). There is no CLI
yet. `detached: false` means the id was not attached. Waiting answers end `replication_timeout` with `end=detached`;
later writes do not wait. To follow again, start the follower with the same `replica` id.

## Diverged tail recovery

A follower (or a stopped old primary) can hold records past the point where a promoted timeline forked: commits the
new primary never had. `apply_*` and `install_snapshot` refuse such a follower `diverged_tail`, changing nothing,
until the tail is exported (`diverged_tail.rs`); the refusal names the fork, the cursor, both lineages and whether the
log still holds the whole tail.

| Call | What it does |
|---|---|
| `Follower::export_diverged_tail(dir, theirs_lineage)` | Writes a new directory (mode 0700, files 0600): a complete image of the follower's records (`records.redb`, `FORMAT`, `SNAPSHOT.json`), so a value whose record retention trimmed is kept; `tail.jsonl`, the raw records after the fork; and `MANIFEST.json` (the sha256 of each file), written last. Refused `export_no_space` when the free space is under image + tail + 16 MiB. Any failure removes what it wrote and permits nothing. Refuses an existing directory, one inside the follower, and a symlinked parent. |
| `Follower::allow_install_over(dir)` | Checks the export against the follower (brain, cursor, lineage, fork, every tail record) and permits one snapshot install over exactly that tail. The permit is in memory; after a restart, call it again with the same directory. |

Runbook: stop following; export with the new primary's lineage (`Follower#exportDivergedTail(dir, lineage)`, the
lineage of any `repl_records` from it, or of `Brain#readCommitLogRaw` on the new primary); check `MANIFEST.json`
exists; start following again with `followPrimary({ divergedTailExport: dir })`, which calls `allowInstallOver(dir)`
and installs the snapshot the primary sends; verify the follower's cursor. With `divergedTailExport` set and no export
there yet, `followPrimary` exports on the first `diverged_tail` from a records frame by itself. The export takes disk
the size of the brain. Merging the exported commits back is a manual step.

## Tests

`tests/commit_log.rs` (both store modes): a follower that reads only the log matches the leader after every commit
and across a restart; per-transaction positions of a forced group commit with a refused transaction; dense positions
under 8 writers; retention, full trim, restart and cursor boundaries; explicit transactions, savepoints and rollbacks;
activation, interrupted activation, log-off refusal, read-only open; a logged base-7 brain whose upgrade and open-time
upkeep are logged and replay; journal origin on and off; the accept hook. `tests/occ_history.rs` and `tests/sim.rs`:
`logged_*` crash and fsync-fault sweeps that replay the recovered log against the recovered records, beside the
existing acknowledged/in-doubt check, and a crash at every I/O call of one group commit. `tests/takeover.rs`: the
promotion fence (live, lapsed, attested with margin 0 and the default margin, hand-over), the primary's write fence on
both record adapters and every write kind (lapse, commit after the lease's end, release, reopen), a transaction begun
before the store served, a second store written while one serves, refused and rolled-back transactions that write
nothing after the lease's end, a reopen that writes nothing and finishes its upkeep and keyword build when it serves,
a write that raced a renewal, a lease taken over (`lease_lost`, not a conflict), a hand-over inside a transaction,
the single-writer refusal, ids not handed out again after a refused rollback, invalid inputs, `promotion_partial` recovery, stale-primary lineage, and the
no-product-path guards. `src/primary/tests.rs` (unit tests on seams): upkeep that outlives the lease is refused, a
serve whose upkeep failed leaves the store refusing writes, and a commit judged before the lease was taken conflicts.
`tests/follower.rs`: a crash at every I/O call of a promotion's durable step, where a
promotion on disk that returned an error names it `promotion_partial`.
`tests/replica_ack.rs`: acked writes survive an attested promotion, a stopped follower and a detach end waits, acks
that cannot be true are refused, a restarted primary waits again, the budget, switch-off, a promotion during a wait,
the durable mark, and promotion notes with and without `acked_seen`. `tests/follower.rs` also covers the diverged
tail: refusals, an export kept byte for byte, a trimmed value kept by the image, unsafe destinations, and every
simulated stop of the export (process stops at each step, not fsync-failure injection) and a tampered file.
