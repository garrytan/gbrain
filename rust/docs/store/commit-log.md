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

Off (the default for all three), nothing on this page happens: no key under tag `2` is written, `FORMAT` and the
format record keep their bytes, journal rows keep their `extra`, the open result keeps its shape and no clock or id
is drawn that was not drawn before. Commit positions are computed either way, and nothing an agent sees shows them.

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

## The accept hook

`Store::set_accept_hook(hook)`: the record file's one writer calls `hook(Accepted { position, commit_time })` once
per accepted transaction, in commit order, at the accept step (the pipeline's accept loop, or the single-writer
commit under redb's write lock), with `commit_time` read from the store's clock. It runs before the commit is
durable, so it may see a commit that then fails. It holds no policy of the store's (lane L5 builds commit-ordered
times on it). Nothing installs one while multi-user mode is off.

## The log

Keys under tag `2` (declared in `commit_log.rs`, claimed in the tag registry of
`docs/designs/RUST_ENGINE_INTERFACES.md`):

- `2`: the meta record, JSON `{ since, newest, trimmed_through }`. `since` is the activation commit, `newest` the
  newest commit with a record (`since` before the first), `trimmed_through` the newest record retention removed.
- `2 sequence_be8 index_be4`: one commit record. Value (all lengths and counts u32 big-endian):
  `[version u8 = 1]` `[host id, incarnation, writer id: each length-prefixed UTF-8]`
  `[count of write ids, each length-prefixed]` `[count of ops; each: op u8, key length-prefixed, operand length-prefixed]`.
  Ops: `1` put (operand: the full value, never a reference), `2` delete (empty operand), `3` `add_i64` (the delta, 8
  bytes little-endian, as counters are stored), `4` `raise_counter` (the value, 8 bytes big-endian, as id sequences
  are stored). One op per key, keys in increasing order. The decoder refuses anything else with `store_corrupt`.

What a record holds:

- Optimistic store: the transaction's own buffered writes, exactly (`put`, `delete`, `add_i64`, `raise_counter`).
  A follower applies records in `(sequence, index)` order, which is the order the pipeline resolved them.
- Single-writer store: the final value or delete of each key the commit wrote (its counter helpers already write
  puts there).
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

## Store format 13 and activation

A brain opened with the log becomes store format 13 (`format::LOG_FORMAT_VERSION`, registry row `opt-in` in
[format.md](format.md)). Its records stay a base format's shapes; the format record keeps the base as
`log.base_format` and `log.since`, and `FORMAT` carries `"log": { "since": ... }`.

```
open with the log on, brain not yet logged:
  base upgrade (unlogged) -> FORMAT stamped 13 + log.since
  -> one exclusive write: format record 13 + meta record (its position is since)
  -> log enabled -> upkeep writes (logged) -> FORMAT written from the records
open of a format-13 brain:
  log on:  enable the log -> base upgrade from log.base_format (logged, keeps 13) -> upkeep (logged)
  log off, writable: refused (format_unknown, names GBRAIN_RUST_MULTIUSER=1), before the record file is opened
  read-only: opens; nothing is written
```

A build without the log refuses a format-13 brain as newer, with and without `FORMAT`, and changes no byte. A crash
after the `FORMAT` stamp and before the records leaves a brain this build finishes with the log on and refuses without
it. A base newer than this build reads is refused.

## Write origin on journal rows

With write origin on, the native admission (`admit_write`, `submit_page_mutation`) and the compatibility path
(`insert_write_request`, `insert_write_request_group`) put into the request record's `extra`: `admitter_host_id`
(the open's host id, unless the caller gave one; an admission's `origin.hostId` overrides it), `admitter_incarnation`
(the open's, or `origin.incarnation`) and `writer_id`. The row the members return shows `admitter_host_id` in its
existing column; the other two are not in any row. Off, `origin` on an admission is ignored and `extra` is unchanged.

## Tests

`tests/commit_log.rs` (both store modes): a follower that reads only the log matches the leader after every commit
and across a restart; per-transaction positions of a forced group commit with a refused transaction; dense positions
under 8 writers; retention, full trim, restart and cursor boundaries; explicit transactions, savepoints and rollbacks;
activation, interrupted activation, log-off refusal, read-only open; a logged base-7 brain whose upgrade and open-time
upkeep are logged and replay; journal origin on and off; the accept hook. `tests/occ_history.rs` and `tests/sim.rs`:
`logged_*` crash and fsync-fault sweeps that replay the recovered log against the recovered records, beside the
existing acknowledged/in-doubt check, and a crash at every I/O call of one group commit.
