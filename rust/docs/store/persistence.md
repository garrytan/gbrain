# The brain store: Persistence journal rows

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The persistence coordinator (`src/core/persistence/`) stays TypeScript. This family stores the rows
it reads and writes, so the typed journal members of `src/core/engine-sql/persistence-journal.ts` and
`persistence-claims.ts` and `persistence-housekeeping.ts` have the same answer on a Rust brain as on
PGLite. The code is `crates/gbrain-store/src/persistence.rs`, with `persistence/housekeeping.rs` and
`persistence/topology.rs` and `persistence/projection_queue.rs`; the native write path (`submitPageMutation`) is in
[journal.md](journal.md).

## Keys

| Key | Record |
| --- | --- |
| `J <principal kind> 0x00 <principal id> 0x00 <request id>` | one `persistence_requests` row (`journal::RequestRecord`), JSON (journal.rs) |
| `j <journal id>` | the request key of that row (journal.rs) |
| `W <writer id>` | one `persistence_local_writers` row (journal.rs) |
| `d 0x01 <counter key>` | one `persistence_counters` row, JSON |
| `d 0x02 <op> 0x00 <fingerprint>` | one `op_checkpoints` row `{ completed_keys, updated_at_us }`, JSON: a housekeeping turn or a resumable op's checkpoint parent (op_checkpoint.rs) |
| `d 0x07 <op> 0x00 <fingerprint> 0x00 <path>` | one `op_checkpoint_paths` row, empty (op_checkpoint.rs). Not `d 0x05` or `d 0x06`, which hold the `persistence_effects` rows and their claim-order index |
| `d 0x03 <principal id> 0x00 <request id>` | one `persistence_topology_changes` row (a lifecycle receipt), JSON (topology.rs) |
| `d 0x04 <source incarnation> 0x00 <slug>` | one `page_projection_jobs` row `{ revision, reason, updated_at_us }`, JSON (projection_queue.rs) |
| `d 0x08 0x01 <host id>` | one `sync_notifier_leases` row `{ owner_id, fence, resident_kind, pid, renewed_at_us, expires_at_us }`, JSON (notifier.rs) |

A counter key is the text of `persistence_counters.key` (`brain`, `principal:<kind>:<id>`).

The `J` record is a superset of `journal::RequestRecord`, by design. A request row that
`insertWriteRequest` stored keeps every `persistence_requests` column: the columns the native journal
reads are named fields, the others are in the record's `extra` map with their table defaults. The
native write path decodes the named fields and keeps `extra` as it found it, so both writers share one
key and one record. A record the native write path stored reads back with those defaults filled in.

`d 0x05` to `d 0x07` are kept for effect rows, effect order and operation checkpoint paths. The commit
notifier owns `d 0x08`; a unit test in notifier.rs checks that its key range stays clear of them.

A queue key holds the incarnation as its 36-byte lower-case UUID text, so key order is
`(source_incarnation, slug)` order, the order of the Postgres primary key.

## Methods

Each method is one store write transaction (or one read). The row locks Postgres takes for these
statements (`FOR SHARE`, `FOR UPDATE`, `SKIP LOCKED`), the advisory locks and the page write guards are
no-ops: the store runs one write transaction at a time, so no read overlaps a write.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.lockPersistenceCounters(keys)` | the counter rows `{ key, outstanding_count, intent_bytes, lifetime_ids, terminal_bytes }`, sorted by key; a missing row is created at zero | `lockPersistenceCounters` |
| `brain.insertWriteRequest(row)` | the stored `WriteRequest`. It charges each counter (one outstanding request, its intent bytes, one lifetime id, its terminal reservation) in the same write. `constraint_violation` for a principal kind, state, target kind or protocol version the table refuses, a null slug, a worktree or refresh id (this engine keeps no worktrees), or a request id the principal already used | `insertWriteRequest` |
| `brain.readWriteRequest({ kind, id }, requestId)` | the `WriteRequest` or `null` | `readWriteRequest` |
| `brain.readWriteRequestById(id)` | the `WriteRequest` or `null` | `readWriteRequestById`, `lockWriteRequest`, `readWriteRequestProgress` (the TS member picks the nine progress columns from this row) |
| `brain.countOutstandingBySource(principalKind, principalId)` | `[{ source_id, n }]`: one row per source that holds requests of the principal in state `queued`, `deferred`, `running` or `recovering`. The most requests come first; a tie is in byte order of the source id, as Postgres sorts `COLLATE "C"` | `countOutstandingBySource` |
| `brain.readCounterRows(keys)` | the `persistence_counters` rows that exist for the keys, in byte order of the key, without creating or locking any; a missing key has no row | `readCounterRows` |
| `brain.readAdmissionRate(principalKind, principalId)` | `{ first_request_id, admissions, age_seconds, gross, net }`: the id of the brain's first request (lowest sequence), then over the latest 1000 requests of the principal (all principals when both are null) their count, the age in seconds of the oldest of them, the mean terminal reservation and the mean compacted receipt size (authority, outcome, error detail and client request id, plus 1 KiB of headroom, at most the reservation; this engine records no effects). The means and the age are null when there are no requests | `readAdmissionRate` |
| `brain.stampWriteClaim({ id, token, leaseMs, phaseJson })` | the claimed row with `passed_sync` and `seen_sequence`, or `null` when the refresh barrier holds it | `stampWriteClaim` |
| `brain.completeWriteRow(completion)` | the ended row (with `purge_has_facts`, `purge_has_pages` when `probePurges`), or `null` when the effects do not fit the reservation. Releases the counters; a terminal counter shorter than the release is clamped to zero and counted in config `persistence.true_up.clamped`. A completion that would take a counter below zero changes nothing and rejects with `constraint_violation` | `completeWriteRow` |
| `brain.renewWriteClaim({ id, token, leaseMs, phaseJson })` | `true` when the claim is still `running` under that token; the lease is extended and the phase replaced when one is given | `renewWriteClaim` |
| `brain.expireStaleWriteClaims({ hostId, charge, deadOwners })` | the number of claims returned to `queued`: an expired lease, or a phase owner in `deadOwners` (`pid:nonce:start`), with publication not started; at most 100, oldest first. `charge` counts one preparation attempt for a claim that expired while preparing | `expireStaleWriteClaims` |
| `brain.hasClaimableWrite({ excludeRoots, priority })` | whether a claim would find a row now. `priority` `null` reads config `sync.foreground_priority` (on unless `0` or `false`) | `hasClaimableWrite` |
| `brain.readSourceMembership(sourceId)` | `{ incarnation, archived }` or `null` | `readSourceMembership`, `readLedgerSource` |

Rows have a null `worktree_id`, so the worktree terms of the claim statements are answered as Postgres
answers them for a null worktree. `select_claimable_write` (the claim head read) exists in the store
but has no binding.

## Steps that refuse by name

Three coordinator steps need one engine transaction, which this engine does not serve yet (the
`transactions` capability). Each refuses before it opens one, with `engine_capability_missing`,
`capability=transactions` and the step's name and reason in the detail, and writes nothing:

| Step | Why it needs a transaction |
| --- | --- |
| `claimNextWrite` (journal.ts) | it selects the head under `FOR UPDATE SKIP LOCKED` and stamps the claim in one transaction |
| `compactReceipt` (journal.ts) | it rechecks the receipt under its row lock and releases the counters in one transaction |
| `trueUpRequests` (receipt-true-up.ts) | it locks the counters and compare-and-sets the reservations in one transaction |

The check is `requireTransactions` in `src/core/rust-engine/errors.ts`; an engine without a
capability set (Postgres, PGLite, a transaction handle) passes. A true-up with nothing to shrink returns
`0` before the check.

## Topology changes

A source lifecycle change (remove, purge, clone, deactivate) records one lifecycle receipt per
(principal, request id). A page write cannot reuse that request id (`assertPageRequestIdentity`), and a
lifecycle retry finds its earlier receipt. Rows are never deleted on this engine.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.insertTopologyChange(row)` | the stored `TopologyChange`. `constraint_violation` for a state the table refuses, a negative byte count, a malformed UUID, or a request id the principal already used | `insertTopologyChange` |
| `brain.readTopologyChange(principalId, requestId)` | the `TopologyChange` or `null` | `readTopologyChange` |
| `brain.findTopologyChanges(principalId, requestIds)` | `[{ request_id }]` for each listed request id the principal used | `findTopologyChanges` |

The counter charges that go with a lifecycle receipt, and the settle, supersede and release updates,
stay raw SQL in `topology-receipts.ts`. They run inside `transaction`, which this engine does not serve
yet.

## Housekeeping

The consumer's housekeeping after a write (`persistence-housekeeping.ts`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.claimHousekeepingTurn({ op, hostId, intervalMs, leaseMs, consumerKinds, consumerLiveMs })` | `true` when the turn is free (no row, or a stamp older than the interval after a finished turn, or than the lease while one is held); the row is then leased to the caller. No resident consumer is ever live here, so none blocks a claim | `claimHousekeepingTurn` |
| `brain.completeHousekeepingTurn({ op, hostId })` | marks a leased turn done; any other row is left as it is | `completeHousekeepingTurn` |
| `brain.readReceiptBudget(retentionKey, floorDays)` | `{ retention, used, cutoff }`: the config value, the brain counter's terminal bytes, and now minus `floorDays` | `readReceiptBudget` |
| `brain.listCompactableReceipts(retentionDays)` | compactable receipts completed more than `retentionDays` ago that are not an unresolved caller refusal, oldest first, at most 100. The open-sync-cursor and newest-sync-receipt exclusions never match (no managed-sync rows, no worktree) | `listCompactableReceipts` |
| `brain.listReservationsAfter(after, limit)` | `{ id, sequence, compacted }` past `after`, in sequence order | `listReservationsAfter` |
| `brain.listTrueUpRequests(ids)` | the true-up candidates; effect bytes are `0` and no effect is unfinished (no `persistence_effects` rows) | `listTrueUpRequests` |
| `brain.readCapacityForecastInputs(light)` | the counters, the per-day rows (the principal rows, then the lifecycle receipts grouped by writer and UTC day), the history and, unless `light`, the reclaim rows. `tableBytes` is `null` (no relation size) | `readCapacityForecastInputs` |
| `brain.listPendingSegmentedProjections(filter)` | the queued jobs of segmented pages that a projector can take now, as `listPendingSegmentedProjections` returns them | `listPendingSegmentedProjections` |
| `brain.selectProjectionWindowJobs(cursor, retryCooldown)` | the window rows (the recency lane, then the wrapped key-order lane), with `high_water` as Postgres prints a `timestamptz`; the one row of nulls for an empty queue | `selectProjectionWindowJobs` |

## Op checkpoints

A resumable op's checkpoint (`src/core/op-checkpoint.ts`): the keys an op already finished, so a run
that stopped midway resumes with only the pending keys. The parent shares the housekeeping key space
(`d 0x02`); a housekeeping op and a resumable op never use the same op name. The child paths sit under
their parent's op and fingerprint, so deleting a parent deletes its paths in the same write, as the
`ON DELETE CASCADE` foreign key does. An op, fingerprint or path with a NUL byte refuses with
`invalid_input`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readOpCheckpointKeys(op, fingerprint)` | `{ keys, corruptParent }`: the child paths in path (byte) order, then the parent's keys, each key once. A null element is skipped and any other non-text element is its JSON text. `corruptParent` is true when the parent's keys are not an array | `readOpCheckpointKeys` |
| `brain.writeOpCheckpointKeys(op, fingerprint, keys)` | the parent's keys replaced with `keys`, stamped now; the paths stay | `writeOpCheckpointKeys` (`recordCompleted`) |
| `brain.appendOpCheckpointPaths(op, fingerprint, paths)` | the parent created with no keys or stamped now, then each path not yet stored added | `appendOpCheckpointPaths` (`appendCompleted`, `appendCompletedOnce`) |
| `brain.deleteOpCheckpoint(op, fingerprint)` | the parent and its paths deleted; a missing parent is a no-op | `deleteOpCheckpoint` (`clearOpCheckpoint`) |
| `brain.deleteOpCheckpointPaths(op, fingerprint)` | the paths deleted, the parent kept | `deleteOpCheckpointPaths` (`clearOpCheckpoint`) |
| `brain.purgeStaleCheckpoints(ttlDays)` | how many parents it deleted: each `d 0x02` parent (housekeeping turns included) stamped more than `ttlDays` days ago that no exemption keeps, with its paths. The exemptions read the rows as they were before the purge. A `ttlDays` that is not a finite number refuses with `invalid_input` | `purgeStaleCheckpoints` (the cycle's purge phase, `bookkeeping-gc.ts`) |

Differences from the SQL engines:

- The SQL read names no order; the store lists the paths in path order. `resumeFilter` and every caller
  use the keys as a set.
- The purge keeps the exemptions whose data the store has: the ops never purged, the sync delete
  tombstone and identity downgrade while their page has the recorded `deleted_at` (read as
  `::timestamptz` reads the writers' text: ISO with `Z`, or the Postgres jsonb form with the
  session's offset, such as `2026-11-19T09:05:00.123456-08:00`), the rows kept
  while their source incarnation lives, and the managed sync run and manifest rules. The store keeps
  no `source_ingestion_receipts`, so the incomplete-receipt exemption never holds. A recorded time or
  hold count the store cannot read keeps the row, where Postgres fails the whole purge (and the
  caller answers 0).
- The sync holds, their summary and the managed sync pass row are whole rows written through the
  checkpoint row methods below. The other `op_checkpoints` writers (sync delete tombstones, sync
  identity downgrades, fence repair, the persistence receipts) are still raw SQL. Their rows are
  not in this store, so the store's unit test is the only check of the tombstone and downgrade
  exemptions on this engine.

## Checkpoint rows

A whole `op_checkpoints` row, read and written as one JSON value (checkpoint_rows.rs). The rows use
the op checkpoint keys (`d 0x02 <op> 0x00 <fingerprint>`), so the purge above and `deleteOpCheckpoint`
see them. The TypeScript members in `src/core/rust-engine/store-members/sync-hold-store.ts` build the
sync hold, hold summary and managed sync pass members on these methods. An op or fingerprint with a
NUL byte reads nothing and refuses a write with `invalid_input`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readOpCheckpointRow(op, fingerprint)` | `{ fingerprint, completed_keys, updated_at }`, or `null` when no row exists | `readGitHoldRow`, `readSyncPassRow`, `countGitHolds` |
| `brain.putOpCheckpointRow(op, fingerprint, completedKeys)` | the row created or replaced, stamped now; its paths stay | `writeGitHoldRow`, `lockGitHoldSummary` (a new summary), `writeSyncPassRow` (a new row) |
| `brain.replaceOpCheckpointRow(op, fingerprint, expected, completedKeys)` | `true` when the row held `expected` and now holds `completedKeys`, stamped now; `false`, writing nothing, when the row is gone or holds anything else | `replaceGitHoldRow`, `adjustGitHoldSummary`, `writeSyncPassRow` (an existing row) |
| `brain.listOpCheckpointRows(op, fingerprintPrefix)` | the op's rows whose fingerprint starts with the prefix (every row for `""`), in fingerprint byte order | `readGitHoldRecords`, `readHeldPageRows`, `readLiveSyncPassRows` |
| `brain.readPageRevisions(ids)` | `{ id, revision }` of each listed page, deleted or not, once each in id order; an unknown or negative id answers nothing | the page join of `readHeldPageRows` |

Differences from the SQL engines:

- The SQL members change a row inside one statement. The TypeScript members read the row, then
  write it with `replaceOpCheckpointRow`, which lands only on the row they read. The summary
  adjustment retries up to 8 times and then throws, where Postgres waits on the row lock.
- `lockGitHoldSummary` takes no lock: it creates a missing summary or re-stamps an existing one.
  Two concurrent hold writes of one path are not serialized; the summary counts stay right because
  each adjustment is a compare-and-replace.
- `read_at` of a pass row is the process clock at the read; the SQL engines use the database clock.
## Commit notifier

The resident commit notifier's host lease, host source list, per-source rows and freshness reads
(`src/core/engine-sql/notifier.ts`; `notifier/store.ts` `claimLease`, `readLease`, `holdsLease`,
`releaseLease`, `readNotifierSources`, `writeState`, `writeCoverage` and `recordSyncerHost`;
`notifier/resident.ts` `listHostSources`; `notifier/status.ts` `readSourceFreshness` and the
`gbrain sync status` notifier block), and its wanted markers (`notifier/store.ts` `upsertMarker`,
`attachMarkerJob`, `readMarkers`, `readDueMarkers`, `pruneSatisfiedMarkers`, `clearMarker` and
`settleMarkers`). With these typed, a resident on this engine starts the notifier and records each
source's state and coverage, a sync request records its marker, and search reports each source's
freshness, as on Postgres.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.claimNotifierLease({ hostId, ownerId, kind, pid, leaseMs })` | `{ owner: true, fence }` when the host has no lease row, the row is the caller's (a renewal keeps the fence) or the row expired (a takeover adds 1 to the fence); the row then holds the caller with an expiry `leaseMs` (rounded, at least 1) from now. Otherwise `{ owner: false, holder: { owner_id, fence, resident_kind, pid, expires_at, live } }`. `invalid_argument` for a host id with NUL | `claimNotifierLease` |
| `brain.readNotifierLease(hostId)` | the host's lease row `{ owner_id, fence, resident_kind, pid, expires_at, live }`, or `null` when it has none. `invalid_argument` for a host id with NUL | `readNotifierLease` |
| `brain.holdsNotifierLease(hostId, ownerId, fence)` | `true` only when the host's row is `ownerId`'s, with `fence`, and not expired: the fencing check before a start | `holdsNotifierLease` |
| `brain.releaseNotifierLease(hostId, ownerId)` | sets the row's expiry to now when the row is `ownerId`'s, in one write; another owner's row, or no row, is left as it is | `releaseNotifierLease` |
| `brain.listNotifierHostSourceRows()` | every source that is not archived, in id order: `{ id, local_path, last_commit, bound, owner, root, syncer, config }`. This engine keeps no managed worktree binding and no source `last_commit`, so `bound` is `false` and `last_commit`, `owner` and `root` are `null`; `syncer` is the host `recordNotifierSyncerHost` recorded, else `null` | `listNotifierHostSourceRows` |
| `brain.readNotifierSources(ids \| null)` | the per-source notifier row of each listed source (every source when `null`) that has one, in id order: the `sync_notifier_sources` columns, timestamps as ISO strings | `readNotifierSources` |
| `brain.writeNotifierState(sourceId, { state, reason, firstDue, attempts, nextRetryInMs, progress, errorGiven, error })` | one write. A first write makes the row (`first_due_at` only for `firstDue: 'keep'`, `attempts` 0 when not given); a later one keeps `first_due_at` (set when null) unless `'clear'`, keeps `attempts` and `last_progress_at` unless given, and replaces the error fields only when `errorGiven`. Nothing for a source that does not exist. `invalid_argument` for a state or number outside the Postgres CHECK and `int` range | `writeNotifierState` |
| `brain.writeNotifierCoverage(sourceId, { head, mode, ownerHostId, ownerKind, ownerPid })` | one write: the observed head, the detection mode and the owner, each with now as its time. Nothing for a source that does not exist | `writeNotifierCoverage` |
| `brain.recordNotifierSyncerHost(sourceId, hostId)` | one write that records the host when it changed; the same host, or a source that does not exist, writes nothing | `recordNotifierSyncerHost` |
| `brain.readNotifierStatusRows(ids \| null)` | each listed source (every source when `null`) that is not archived, in id order, at most 200, with its row (null fields when it has none), `lease_live` (the owner host's lease has not expired) and `lease_expires_at`. `last_commit` is `null` (this engine keeps no source `last_commit`) and `due_markers` counts the source's due wanted markers | `readNotifierStatusRows` |
| `brain.hasNotifierCoverage()` | `true` when some source's row has an observed time | `hasNotifierCoverage` |
| `brain.upsertWantedMarker({ sourceId, intent, wantedHead, requestedBy, jobId })` | one write. A first upsert makes the marker at generation 1 with `first_due_at` now; a later one bumps the generation, takes the new `wanted_head` and requester, keeps `job_id` when none is given, and keeps `first_due_at` unless the source was re-created. The marker `{ source_id, intent, wanted_head, generation, first_due_at, updated_at, requested_by, job_id }`, or `null` for a source that does not exist. `invalid_argument` for an intent other than `freshness`, `pull` or `full` | `upsertWantedMarker` |
| `brain.attachWantedMarkerJob(sourceId, intent, generation, jobId)` | sets the job id only while the marker is still at `generation`, in one write | `attachWantedMarkerJob` |
| `brain.readWantedMarkers(ids \| null)` | the markers of the listed sources (every source when `null`), ordered by `first_due_at`, source id and intent, at most 1000 | `readWantedMarkers` |
| `brain.readDueWantedMarkers(ids \| null)` | the same read, limited to sources that exist. Every such marker is due: with no source `last_commit`, a freshness marker that names a head never matches it, as on Postgres with a null `last_commit` | `readDueWantedMarkers` |
| `brain.pruneSatisfiedWantedMarkers(ids)` | writes nothing: a marker is satisfied only when its head equals the source's `last_commit`, which this engine does not keep | `pruneSatisfiedWantedMarkers` |
| `brain.clearWantedMarker(sourceId, intent, generation)` | deletes the marker only at `generation`, in one write; `true` when it deleted one | `clearWantedMarker` |
| `brain.settleFreshnessMarker(sourceId, generation, checkoutHead)` | deletes the source's freshness marker only at `generation` and only when its `wanted_head` is null, in one write | `settleFreshnessMarker` |
| `brain.listSourceWantedMarkers(sourceId)` | the source's markers `{ intent, wanted_head, first_due_at, requested_by }`, ordered by `first_due_at` and intent, for the `gbrain sync status` notifier block | `listSourceWantedMarkers` |

The drain lease still refuses with `engine_capability_missing`; the notifier logs the refusal once
and keeps running. A source delete removes its notifier row and its wanted markers. A freshness
marker that names a head stays due on this engine until a drain clears it by generation.

## Effect scans

The effect worker's reads before and when it claims effects (`persistence-effect-scans.ts`). Each one joins
`persistence_effects` to the worktrees the host owns. This engine keeps no worktree and records no
effect, so each scan answers no row. The arguments are checked as the Postgres casts check them: a host
id that is not a uuid refuses with `invalid input syntax for type uuid: "<id>"`, an `after` that is
not a bigint with `invalid input syntax for type bigint: "<after>"` (or `value "<after>" is out of range
for type bigint`), a fractional limit with the same bigint syntax message and a negative limit with
`LIMIT must not be negative`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listGatedMirrorRequests(hostId)` | `[]`: no withdrawal mirror is parked on a worktree here. The gate and allowed codes change nothing, so they are not sent | `listGatedMirrorRequests` |
| `brain.listEffectRecoveries(hostId, after, limit)` | `[]`: no effect carries a recovery on a worktree here | `listEffectRecoveries` |
| `brain.selectClaimableEffect(hostId)` | `null`: no effect is recorded here, so none is claimable. The dead owner keys change nothing, so they are not sent | `selectClaimableEffect` |

## Projection queue

Every page write updates the queue in the same store transaction, as PGLite's
`gbrain_queue_page_projection` trigger does: a new knowledge revision that is not sealed queues or
re-queues the page's job; a seal, a soft delete or a delete removes it; a rename or a move removes the
job of the old key. `updated_at` is the transaction's clock: the first read of the clock in a store
write transaction is kept for the rest of it, as Postgres `now()` is. The trigger is the only writer of
jobs on this engine. The other `reason` values (`segmented_projecting`, `rebuild_failed`,
`chunk_replacement_continuing`) are written only by raw SQL, which this engine refuses, so every job
here has reason `canonical_change`; the reads still apply every reason filter. A store written before
the queue existed has no job for a page it left unsealed, and nothing backfills one: no released Rust
brain predates the queue, so no such store exists outside development.

## TypeScript members with no stored state

| Member | Answer | Why |
| --- | --- | --- |
| `readLedgerSource(sourceId, opts?)` | `{ incarnation, purgeEpoch: 0, coverage: null, purgesPossible: false }`; a batch adds `managedRows: [{ enabled: false }]` and `planModePrev: 'auto'` | Belief events and fact, take and page purges are written only through `executeRaw`, which this engine refuses. |
| `listHostConsumerRows(hostId, opts?)`, `probeLiveConsumerRows(probe, opts?)` | `[]` | One process owns this engine's brain, so it keeps no consumer heartbeat rows. PGLite, which also admits one process, answers the same in its callers (`listHostConsumers`, `probeLiveFullConsumer`) without a read. |
| `renewConsumerRow(renewal, opts?)`, `deleteConsumerRow(key, opts?)`, `stampWorktreeHeartbeats(hostId, opts?)` | resolve with no effect | The heartbeat has no row to renew or delete, and this engine has no worktrees to stamp. |
