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
| `d 0x05 <journal id> 0x00 <kind>` | one `persistence_effects` row, every column, JSON (persistence/effects.rs) |
| `d 0x06 <effect id, 8 bytes big-endian>` | `{ request_id, kind }`: the effect's `d 0x05` key, in id (claim) order (persistence/effects.rs) |
| `d 0x08 0x01 <host id>` | one `sync_notifier_leases` row `{ owner_id, fence, resident_kind, pid, renewed_at_us, expires_at_us }`, JSON (notifier.rs) |
| `d 0x09 0x01 <worktree id>` | one `persistence_worktrees` row, JSON (worktrees.rs) |
| `d 0x09 0x02 <worktree id> 0x00 <host id>` | one `persistence_host_bindings` row, JSON (worktrees.rs) |
| `d 0x09 0x03 <source id>` | one `persistence_source_bindings` row, JSON (worktrees.rs) |
| `d 0x09 0x04` | the brain mode `{ enabled, mode_epoch, activated_at_us }` of `persistence_brain`, JSON (worktrees/release.rs); absent reads as `enabled` false, `mode_epoch` 1 |
| `d 0x10 <refresh id>` | one `persistence_worktree_refreshes` row (`RefreshRecord`), JSON (persistence/worktree_admission.rs) |

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
| `brain.insertWriteRequest(row)` | the stored `WriteRequest`. It charges each counter (one outstanding request, its intent bytes, one lifetime id, its terminal reservation) in the same write. `constraint_violation` for a principal kind, state, target kind or protocol version the table refuses, a null slug, a refresh id that names no `d 0x10` refresh row, or a request id the principal already used; `invalid_argument` for a principal id holding a NUL byte. A worktree id that is not a uuid refuses with the uuid syntax message, and one with no `persistence_worktrees` row refuses `constraint_violation` (`worktree_id <id> names no persistence_worktrees row`, the foreign key; see "Worktree rows") | `insertWriteRequest` |
| `brain.insertWriteRequestGroup(rows)` | the stored `WriteRequest`s in order, each inserted and charged as `insertWriteRequest` does, all in one store write: a refusal at any row keeps no row and no charge | `insertWriteRequestGroup` (journal.ts `admitWriteGroupInTransaction`) |
| `brain.readWriteRequest({ kind, id }, requestId)` | the `WriteRequest` or `null` | `readWriteRequest` |
| `brain.readWriteRequestById(id)` | the `WriteRequest` or `null` | `readWriteRequestById`, `lockWriteRequest`, `readWriteRequestProgress` (the TS member picks the nine progress columns from this row) |
| `brain.countOutstandingBySource(principalKind, principalId)` | `[{ source_id, n }]`: one row per source that holds requests of the principal in state `queued`, `deferred`, `running` or `recovering`. The most requests come first; a tie is in byte order of the source id, as Postgres sorts `COLLATE "C"` | `countOutstandingBySource` |
| `brain.readWorktreeAdmission({ worktreeId, sourceId, sourceIncarnation, topologyGeneration })` | `{ worktree, refresh, bound }`. `worktree` is `{ state, owner_epoch }` (the epoch as text) from the worktree row, or null when no row has the id; `refresh` is the worktree's refresh in an active state (`draining`, `fenced`, `merged`, `syncing`, `recovery_required`) or null; `bound` is whether the source's binding names this incarnation, worktree and topology generation (a null generation binds nothing). The ids must be uuids; a generation that is not a Postgres integer refuses with the integer syntax or range message | `readWorktreeAdmission` |
| `brain.completeSyncedRefresh(refreshId)` | `true` when the refresh was `syncing` and none of its member sources still differs from its target head, and is now `completed`. The store keeps no `last_commit`, so a stored member source always differs | `completeSyncedRefresh` |
| `brain.hasDeferralRoom(worktreeId, liveMs)` | `true`: no consumer rows are stored, so no live consumer lacks the capability. `liveMs` must fit a Postgres integer | `hasDeferralRoom` |
| `brain.readRefreshTiming(refreshId)` | `{ elapsed_ms, typical_ms }` or null: the refresh's running time and the median duration of its worktree's last 10 completed refreshes without a refusal | `readRefreshTiming` |
| `brain.countHeldBehindImport(sourceId, principalKind, principalId)` | `{ count, bytes }`: the `deferred` requests not yet released that wait on the source's import or on an unreleased refresh the source is a member of; the principal filter applies when both are given | `countHeldBehindImport` |
| `brain.readCounterRows(keys)` | the `persistence_counters` rows that exist for the keys, in byte order of the key, without creating or locking any; a missing key has no row | `readCounterRows` |
| `brain.readAdmissionRate(principalKind, principalId)` | `{ first_request_id, admissions, age_seconds, gross, net }`: the id of the brain's first request (lowest sequence), then over the latest 1000 requests of the principal (all principals when both are null) their count, the age in seconds of the oldest of them, the mean terminal reservation and the mean compacted receipt size (authority, outcome, error detail and client request id, plus each of its effects' data and kind and 1 KiB of headroom, at most the reservation). The means and the age are null when there are no requests | `readAdmissionRate` |
| `brain.stampWriteClaim({ id, token, leaseMs, phaseJson })` | the claimed row with `passed_sync` and `seen_sequence`, or `null` when the refresh barrier holds it. A `deferred` row is claimed only once its refresh is released (`RELEASED_DEFERRED`); before that the claim rejects with `constraint_violation` and the `writer_upgrade_required` message of `gbrain_guard_deferred_request`. `completeWriteRow` and the journal finish end a `deferred` row only as `conflict`, `failed` or `cancelled`, and no update makes a row `deferred` | `stampWriteClaim` |
| `brain.completeWriteRow(completion)` | the ended row (with `purge_has_facts`, whether the source holds a fact purge tombstone, and `purge_has_pages`, always false, when `probePurges`), or `null` when the result and the request's effects do not fit the reservation. The whole reservation stays charged while an effect is unfinished; otherwise the result and effect bytes are kept. Releases the counters; a terminal counter shorter than the release is clamped to zero and counted in config `persistence.true_up.clamped`. A completion that would take a counter below zero changes nothing and rejects with `constraint_violation`. The outcome and error detail are stored with their object keys in jsonb order (shorter keys first, then bytes, at every depth), as a `jsonb` column keeps them | `completeWriteRow` |
| `brain.cancelWriteRow(cancellation)` | `null` when the request does not exist; `{ status: 'kept', row }` with the row unchanged when it is terminal, publishing, in recovery, or no longer in `expectState` under `expectExecutionToken`; `{ status: 'too_large', row }` when the result does not fit the reservation; else `{ status: 'cancelled', row }` with the row `completeWriteRow` ends. The read, the check and the completion run in one store write, so of two cancels of one request exactly one ends it. A state other than `cancelled` rejects with `constraint_violation` | `cancelWriteRow` |
| `brain.releaseUnpublishedClaim({ id, token, reason, charge })` | `true` when the request was `running` under that token with no recovery record and no publication begun; it is back in `queued` with `reason` as its blocked reason, no token and no lease. `charge` counts one preparation attempt and keeps the claim phase; otherwise the phase is cleared | `releaseUnpublishedClaim` |
| `brain.renewWriteClaim({ id, token, leaseMs, phaseJson })` | `true` when the claim is still `running` under that token; the lease is extended and the phase replaced when one is given | `renewWriteClaim` |
| `brain.expireStaleWriteClaims({ hostId, charge, deadOwners })` | the number of claims returned to `queued`: an expired lease, or a phase owner in `deadOwners` (`pid:nonce:start`), with publication not started; at most 100, oldest first. `charge` counts one preparation attempt for a claim that expired while preparing | `expireStaleWriteClaims` |
| `brain.hasClaimableWrite({ hostId, excludeRoots, priority })` | whether a claim would find a row now. `priority` `null` reads config `sync.foreground_priority` (on unless `0` or `false`). A host id that is not a uuid refuses with the uuid syntax message | `hasClaimableWrite` |
| `brain.selectClaimableWrite({ hostId, excludeRoots, fifoRoots, laneRoots, nonce, syncSeen, priority, leaseHolder })` | the request row a FIFO claim takes next, or `null`. A row is a candidate when it is `queued` or a `deferred` row whose refresh is released. With `leaseHolder` (`{ lockPrefix, pid, host }`, a non-resident consumer), a managed-sync row whose lock `lockPrefix + source_id` is live and held by another process ranks last; then a foreground row before the sync rows it passes, then sequence order. A root in `fifoRoots` claims plain FIFO; with any lane root only a foreground row is claimed. `nonce` and `syncSeen` feed the sync-wait term, which matches worktree rows only. A host id that is not a uuid, or a fractional or out-of-range `pid`, refuses as the Postgres casts do | `selectClaimableWrite` |
| `brain.readSourceMembership(sourceId)` | `{ incarnation, archived }` or `null` | `readSourceMembership`, `readLedgerSource` |

A candidate row that names a worktree is claimed only by a consumer of the host that owns the worktree
while the worktree is `active`, with no fence (`fenced`, `merged`, `recovery_required`) refresh, no
recovery on a request or effect there, and no unsettled withdrawal mirror covering its slug; an earlier
write on the same worktree holds it as the Postgres statement does (see "Worktree rows"). Rows with a null
`worktree_id` are ordered by their source incarnation. `hasClaimableWrite` is the claimable test alone:
the lane, FIFO and sync-wait terms belong to `selectClaimableWrite`.

## Worktree rows

The worktree binding (`claimWorktree` and the `persistence_worktrees`, `persistence_source_bindings` and
`persistence_host_bindings` tables) writes its rows under `d 0x09` (`persistence/worktrees.rs`, see "Worktree
bindings"). Every member that meets a worktree id
reads the row through one place (`persistence/worktree_rows.rs`): the worktree's owner host, owner epoch
and state, and a source binding's incarnation, worktree and topology generation, with the column
defaults for a field the record leaves out. Ids are uuids, so a lookup ignores case. A record that is
not valid JSON refuses `store_corrupt`; a member never answers "no row" for a row it cannot parse.

The claim terms that join a worktree row live in `persistence/write_claim_terms.rs`: the owner and
`active` check, the fence refresh, the recovery on the worktree, and the withdrawal-mirror cover. The
write claim, the effect claim, the idle probe, the no-op embedding settle, the gated-mirror scan, the
owner scans and admission all use them. The write and effect inserts refuse a worktree id with no row
as the foreign key does. Expiry (`expireStaleWriteClaims`) releases only the claims on worktrees the
host owns, and claims with a null worktree.

## Receipt list

The candidate page that `list_write_requests` (`persistence/control.ts` `listWriteRequests`) authorizes and pages
(`crates/gbrain-store/src/persistence/receipt_list.rs`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listWriteRequestRows({ kind, id }, sourceId, filter)` | the `WriteRequest` rows of the principal in the source, newest sequence first, at most `filter.limit`. A source that is missing or archived, or a request from an earlier incarnation of the source, gives no row | `listWriteRequestRows` |

The filter is `{ before, limit, slugPrefixes, operations, slugAllowList }`. A null list skips its check and an empty
list matches no row, as the SQL `IS NULL OR EXISTS` terms do.

- `before` is a sequence as decimal text; only lower sequences are listed. Text that is not a `u64` refuses with
  `invalid`.
- `slugPrefixes` match the lower-case slug (Postgres `lower`). An empty prefix matches nothing. A prefix that ends
  in `/` matches the slugs that start with it; any other prefix matches the slug itself or the slugs under it.
- `operations` match `authority.attestedOp` (a JSON value that is not a string as its JSON text), else `operation`.
- `slugAllowList` holds exact slugs (case-sensitive) or `<prefix>/*`, which matches the slugs that start with
  `<prefix>/`.

Lengths count characters, as Postgres `left` and `length` do.

## Steps that need one transaction

Three coordinator steps run as one engine transaction. Each calls `requireTransactions`
(`src/core/rust-engine/errors.ts`) before it opens one: an engine whose capability set lacks
`transactions` refuses with `engine_capability_missing`, `capability=transactions` and the step's name
and reason in the detail, and writes nothing. This engine serves `transactions`, so the check passes;
an engine without a capability set (Postgres, PGLite, a transaction handle) passes too.

| Step | Why it needs a transaction |
| --- | --- |
| `claimNextWrite` (journal.ts) | it selects the head under `FOR UPDATE SKIP LOCKED` and stamps the claim in one transaction |
| `compactReceipt` (journal.ts) | it rechecks the receipt under its row lock and releases the counters in one transaction |
| `trueUpRequests` (receipt-true-up.ts) | it locks the counters, then `trueUpReservations` compare-and-sets the reservations and releases the freed bytes |

A true-up with nothing to shrink returns `0` before the check.

## Topology changes

A source lifecycle change (remove, purge, clone, deactivate) records one lifecycle receipt per
(principal, request id). A page write cannot reuse that request id (`assertPageRequestIdentity`), and a
lifecycle retry finds its earlier receipt. Rows are never deleted on this engine.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.insertTopologyChange(row)` | the stored `TopologyChange`. `constraint_violation` for a state the table refuses, a negative byte count, a malformed UUID, or a request id the principal already used | `insertTopologyChange` |
| `brain.readTopologyChange(principalId, requestId)` | the `TopologyChange` or `null` | `readTopologyChange` |
| `brain.findTopologyChanges(principalId, requestIds)` | `[{ request_id }]` for each listed request id the principal used | `findTopologyChanges` |
| `brain.listTopologyRecoveries(hostId, after, limit)` | the changes with a recovery whose `recovery.worktreeId` names a worktree host `hostId` owns, after id `after` when given (null: from the start), in id order, at most `limit`. A host id, cursor or `worktreeId` that is not a uuid refuses with the uuid syntax message; a `worktreeId` that names no worktree, or one another host owns, is left out | `listTopologyRecoveries` (topology-recovery.ts `recoverSourceTopologies`) |

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
| `brain.listTrueUpRequests(ids)` | the terminal requests among `ids`, in no set order, with `effect_bytes` (the request's effect rows summed as `EFFECT_BYTES_SQL` sums them, as text) and `unfinished` (an effect is `queued` or `running`) | `listTrueUpRequests` |
| `brain.trueUpReservations(rows)` | the bytes given back, as text. Each `{ id, old, kept, effects }` whose request still reserves `old`, still has `effects` effect bytes and has no `queued` or `running` effect now reserves `kept`. The freed bytes, summed per counter (the brain and the request's principal), leave the counters that exist, clamped at zero; each clamped counter adds one to config `persistence.true_up.clamped`. A changed or unknown request changes nothing. `invalid` for a malformed id or effect byte count | `trueUpReservations` |
| `brain.readCapacityForecastInputs(light)` | the counters, the per-day rows (the principal rows, then the lifecycle receipts grouped by writer and UTC day), the history and, unless `light`, the reclaim rows. `tableBytes` is `null` (no relation size) | `readCapacityForecastInputs` |
| `brain.listPendingSegmentedProjections(filter)` | the queued jobs of segmented pages that a projector can take now, as `listPendingSegmentedProjections` returns them | `listPendingSegmentedProjections` |
| `brain.selectProjectionWindowJobs(cursor, retryCooldown)` | the window rows (the recency lane, then the wrapped key-order lane), with `high_water` as Postgres prints a `timestamptz`; the one row of nulls for an empty queue | `selectProjectionWindowJobs` |
| `brain.claimSegmentedProjection(sourceId, slug, claim)` | `claimed` when the page's job takes `claim` (no live `segmented_projecting` claim younger than 60 seconds holds it), `held` when one does, `absent` when the source or the job is missing | `claimSegmentedProjection` |
| `brain.renewSegmentedProjectionClaim(sourceId, slug, claim)` | `true` and the job's time set to now when the job still carries `claim`; `false` otherwise, changing nothing | `renewSegmentedProjectionClaim` |
| `brain.releaseSegmentedProjectionClaim(sourceId, slug, claim)` | a job still carrying `claim` back to `canonical_change` at now | `releaseSegmentedProjectionClaim` |
| `brain.deleteProjectionJob({ sourceIncarnation, slug, revision })` | the job deleted when it is queued at `revision`; a non-uuid incarnation or revision is refused | `deleteProjectionJob` |
| `brain.markProjectionRebuildFailed({ sourceIncarnation, slug, revision })` | a job queued at `revision` and not under a live claim marked `rebuild_failed` at now | `markProjectionRebuildFailed` |

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
| `brain.listNotifierHostSourceRows()` | every source that is not archived, in id order: `{ id, local_path, last_commit, bound, owner, root, syncer, config }`. This engine keeps no managed worktree binding, so `bound` is `false` and `owner` and `root` are `null`; `last_commit` is the commit the source's last git sync reached (`advanceSourceCommit`); `syncer` is the host `recordNotifierSyncerHost` recorded, else `null` | `listNotifierHostSourceRows` |
| `brain.readNotifierSources(ids \| null)` | the per-source notifier row of each listed source (every source when `null`) that has one, in id order: the `sync_notifier_sources` columns, timestamps as ISO strings | `readNotifierSources` |
| `brain.writeNotifierState(sourceId, { state, reason, firstDue, attempts, nextRetryInMs, progress, errorGiven, error })` | one write. A first write makes the row (`first_due_at` only for `firstDue: 'keep'`, `attempts` 0 when not given); a later one keeps `first_due_at` (set when null) unless `'clear'`, keeps `attempts` and `last_progress_at` unless given, and replaces the error fields only when `errorGiven`. Nothing for a source that does not exist. `invalid_argument` for a state or number outside the Postgres CHECK and `int` range | `writeNotifierState` |
| `brain.writeNotifierCoverage(sourceId, { head, mode, ownerHostId, ownerKind, ownerPid })` | one write: the observed head, the detection mode and the owner, each with now as its time. Nothing for a source that does not exist | `writeNotifierCoverage` |
| `brain.recordNotifierSyncerHost(sourceId, hostId)` | one write that records the host when it changed; the same host, or a source that does not exist, writes nothing | `recordNotifierSyncerHost` |
| `brain.readNotifierStatusRows(ids \| null)` | each listed source (every source when `null`) that is not archived, in id order, at most 200, with its row (null fields when it has none), `lease_live` (the owner host's lease has not expired) and `lease_expires_at`. `last_commit` is the source's own and `due_markers` counts the source's due wanted markers | `readNotifierStatusRows` |
| `brain.hasNotifierCoverage()` | `true` when some source's row has an observed time | `hasNotifierCoverage` |
| `brain.upsertWantedMarker({ sourceId, intent, wantedHead, requestedBy, jobId })` | one write. A first upsert makes the marker at generation 1 with `first_due_at` now; a later one bumps the generation, takes the new `wanted_head` and requester, keeps `job_id` when none is given, and keeps `first_due_at` unless the source was re-created. The marker `{ source_id, intent, wanted_head, generation, first_due_at, updated_at, requested_by, job_id }`, or `null` for a source that does not exist. `invalid_argument` for an intent other than `freshness`, `pull` or `full` | `upsertWantedMarker` |
| `brain.attachWantedMarkerJob(sourceId, intent, generation, jobId)` | sets the job id only while the marker is still at `generation`, in one write | `attachWantedMarkerJob` |
| `brain.readWantedMarkers(ids \| null)` | the markers of the listed sources (every source when `null`), ordered by `first_due_at`, source id and intent, at most 1000 | `readWantedMarkers` |
| `brain.readDueWantedMarkers(ids \| null)` | the same read, limited to sources that exist and to due markers: a freshness marker that names a head is not due once that head is the source's `last_commit` | `readDueWantedMarkers` |
| `brain.pruneSatisfiedWantedMarkers(ids)` | deletes, in one write, each listed source's freshness and pull markers whose `wanted_head` equals the source's `last_commit` | `pruneSatisfiedWantedMarkers` |
| `brain.clearWantedMarker(sourceId, intent, generation)` | deletes the marker only at `generation`, in one write; `true` when it deleted one | `clearWantedMarker` |
| `brain.settleFreshnessMarker(sourceId, generation, checkoutHead)` | deletes the source's freshness marker only at `generation`, and only when its `wanted_head` is null or the source's `last_commit`, or the `last_commit` equals `checkoutHead`, in one write | `settleFreshnessMarker` |
| `brain.listSourceWantedMarkers(sourceId)` | the source's markers `{ intent, wanted_head, first_due_at, requested_by }`, ordered by `first_due_at` and intent, for the `gbrain sync status` notifier block | `listSourceWantedMarkers` |
| `brain.readFirstDue(sourceIds)` | one row `{ source_id, observed_head, first_due_at }` per listed source that exists, in id order. `first_due_at` is the earlier of the notifier row's `first_due_at` (only when its state is not `idle` and it belongs to the source's current incarnation) and the oldest due freshness marker of that incarnation, else `null`; for `gbrain sources status` | `readFirstDue` |

The drain lease still refuses with `engine_capability_missing`; the notifier logs the refusal once
and keeps running. A source delete removes its notifier row and its wanted markers. A freshness
marker that names a head stays due on this engine until a drain clears it by generation.

## Writer versions

Which binaries admitted and published the retained requests (`writer-versions.ts`), from the
`admitter_*` and `consumer_*` stamps on each request. Postgres reads its cutoff from
`persistence_brain.writer_version_cutoff`, the moment migration 178 started stamping requests. This
engine stamps every request from the brain's creation, so its cutoff is the brain's creation time. No
request is bound to a worktree here, so an unstamped consumer has no owner host to fall back to.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readWriterVersionCutoff()` | the brain's creation time as ISO text, `null` without a format record | `readWriterVersionCutoff` |
| `brain.listWriterVersions(limit)` | per role, the latest request of each host and principal (a consumer only for a committed request), newest first (null times first, ties by role, host, principal), at most `limit` | `listWriterVersions` |
| `brain.recentWriterVersions(days)` | the committed requests published in the last `days`, grouped per role, host, principal and version with a `requests` count; admitters count from the cutoff by admission, consumers by publication; newest first. A `days` out of range refuses as `readSegmentedGateEvidence` does | `recentWriterVersions` |
| `brain.readSegmentedGateEvidence(days)` | every writer seen in the last `days`, grouped per role, host, principal, version and segment-reader mark, with `requests`, `first_seen` and `last_seen`, newest first: admitters in any state, consumers of committed requests published in the window (the worktree owner for an unstamped host) and importers per ingest log row (`ingest:<source_type>`, from the `logIngest` writer stamp). No consumer row is stored here, so no `resident` row is answered. A `days` that is not finite or past the interval's 32-bit day field refuses with `interval out of range`, and a window start before 4714 BC (or past this clock's range) with `timestamp out of range`, as the SQL refuses them | `readSegmentedGateEvidence` (writer-versions.ts `segmentedGateEvidence`) |

## Effect scans

The effect worker's reads before and when it claims effects (`persistence-effect-scans.ts`). Each one joins
`persistence_effects` to the worktrees the host owns. The effect-recovery scan belongs to the worktree
binding and answers no row; the claim read answers the next effect (see "Effect worker"). The arguments are checked as the Postgres casts check them: a host
id that is not a uuid refuses with `invalid input syntax for type uuid: "<id>"`, an `after` that is
not a bigint with `invalid input syntax for type bigint: "<after>"` (or `value "<after>" is out of range
for type bigint`), a fractional limit with the same bigint syntax message and a negative limit with
`LIMIT must not be negative`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listGatedMirrorRequests(hostId, gateCode, allowedCodes)` | the distinct requests (`id`, `source_id`, `request_id`; at most 100) of each withdrawal mirror parked (`failed`, `targets_parked`) on a worktree the host owns, with a target parked under `gateCode`, when every unsettled effect of the request is parked only with codes in `allowedCodes`. Parked targets that are not an array refuse as `jsonb_array_elements` does | `listGatedMirrorRequests` |
| `brain.listEffectRecoveries(hostId, after, limit)` | `[]`: the effect recovery writer has not landed here, so no effect carries a recovery | `listEffectRecoveries` |
| `brain.selectClaimableEffect(hostId, deadOwners)` | the effect row the worker claims next, or `null` (see "Effect worker") | `selectClaimableEffect` |

## Publication effects

`brain.insertPublicationEffects({ requestId, revision, sourceId, sourceIncarnation, worktreeId, effects })`
stores a publication's effects (`insertPublicationEffects`), each `{ kind, data, gated }`, in one write.
It resolves the kinds it inserted, in queue order. Every kind is stored, `queued`, with `attempts` 0 and
`next_attempt_at` now, under the next effect id (one above the highest stored id), so ids follow queue
order. A `gated` kind is left out while config `auto_link` or `mcp.remote_auto_links` is off (`false`,
`0`, `no` or `off`, any case, trimmed), and a kind already stored for the request is kept as it is, as
`ON CONFLICT DO NOTHING` keeps it. A request id, revision or incarnation that is not a uuid refuses
with the uuid syntax message; a journal id with no request row refuses `constraint_violation` (the
foreign key), and so does an effect with no kind or no data. A worktree id with no
`persistence_worktrees` row refuses `constraint_violation` the same way when a kind is stored (a kept
duplicate never checks it; see "Worktree rows"). Nothing is
stored on a refusal.

`brain.readRequestEffects(requestId, kind)` resolves `{ kind, state, error_code, outcome, recovering }` for
each stored effect of the request in kind order, or only its `kind` effect when one is named (`readRequestEffects`,
the reads a write receipt makes). A request id that is not a uuid refuses with the uuid syntax message.

The effect worker claims and settles these rows (see "Effect worker"). The receipt names a row that
exists, and the write's reservation stays charged until the effect ends.

## Withdrawal effects

`brain.insertWithdrawalEffects({ requestId, sourceId, data })` queues the effects a forget under a write
request leaves (`insertWithdrawalEffects`, the statement `recordFactWithdrawal` sent through `executeRaw`):
one `withdrawal-mirror`, `git` and `embedding` row, in that order, each `queued` with `data`, a null
revision, the source's incarnation and the worktree of the source's binding when the binding names that
incarnation, else a null worktree. It resolves the
kinds it inserted. An unknown source inserts nothing, as the statement's `FROM sources` yields no row; a
kind already stored for the request is kept. A request id that is not a uuid refuses with the uuid syntax
message, and a request with no row refuses `constraint_violation` (the foreign key). Inside `transaction`
it is one more write of the withdrawal's store write, so the effects commit with the withdrawal.

## Effect worker

The statements the effect worker sends to claim one effect and to settle its claim
(`persistence-effect-worker.ts`), with the PostgreSQL rules. The store is single-writer, so a read
takes no row lock.

`brain.selectClaimableEffect(hostId, deadOwners)` resolves the effect row with the lowest
(`next_attempt_at`, id) that is `queued`, `running` with an expired claim, or `running` under a dead
owner (`deadOwners` holds `pid:nonce:start` keys; the claim's `host_id` must be `hostId`), that is due
now and not recovering, and that is a withdrawal mirror or belongs to a request with no `queued` or
`running` withdrawal mirror. An effect on a worktree is claimed only when the host owns the active
worktree and the worktree has no fence refresh and no recovery (see "Worktree rows"). It resolves `null`
when no effect is claimable.

`brain.stampEffectClaim({ id, token, ownerJson })` marks the effect `running` under `token` for two
minutes, adds one attempt and stores the claim owner; it resolves the claimed row, or `null` when no
effect has the id. `brain.settleEffect(action, { id, token, slug, outcomeJson, dataJson, reason, delayMs })`
runs one settle statement and resolves `true` when it matched the claim (`id`, `token`, not recovering).
A `null` token matches no row.

| `action` | Sets | Mirrors |
| --- | --- | --- |
| `renewEffectClaim` | the claim's expiry to two minutes from now | `renewEffectClaim` |
| `advanceEffectRow` | `queued`, `after_slug`; an embedding stores `embedding_attempt_base`, another kind drops `target_failures` and `failing_target` | `advanceEffectRow` |
| `completeEffectRow` | `committed` with the outcome, the retry keys dropped; `failed` with `targets_parked` when a target is parked | `completeEffectRow` |
| `retryEffectRow`, `retryBusyEffectRow` | `queued` after `delayMs` with the reason (`writer_busy` and the new data for the busy retry) | `retryEffectRow`, `retryBusyEffectRow` |
| `requeueEffectRow` | `queued` after `delayMs` with the new data and reason | `requeueEffectRow` |
| `parkEffectRow`, `failEffectRow` | `failed` with the new data (`targets_parked`) or the reason | `parkEffectRow`, `failEffectRow` |

`brain.readMirrorGateRows(requestIds)` resolves `{ request_id, state, data }` for each withdrawal mirror
of the requests that is not committed or that has published. `brain.hasRearmableTargets(requestIds, code)`
resolves whether a Git or embedding effect of the requests, `queued` or `failed`, unclaimed, not
recovering and not settled, has a target parked under `code` while its request's withdrawal mirror has
committed. A request id or host id that is not a uuid refuses with
`invalid input syntax for type uuid: "<id>"`, and an effect id that is not a bigint with the bigint
syntax message.

## Idle probe

`brain.probeIdleWork(spec)` answers the consumer's idle probe (`persistence-idle-probe.ts`):
`{ work, projection_work, projection_last, high_water }`. `spec` holds `hostId`, `excludedRoots`,
`publishing`, `retryingTopologies`, `laneRoots`, the projection `cursor`, `abandonedBefore` and
`foregroundPriority`. `work` is true when one of these holds:

- a write the claim may take (`queued`, or `deferred` with its refresh released) is claimable (the
  claim rules above, with `excludedRoots` and `laneRoots`) and is not blocked for writer pool capacity,
  unless `publishing` is set. A running or recovering write is not claimable work;
- a running write that has not published, with no recovery, has an expired claim, on no worktree or on
  one the host owns;
- an effect is due as the probe states it: `queued`, or `running` with an expired claim, due now, not
  recovering, on no worktree or on a worktree the effect claim may take, and a withdrawal mirror or of a
  request whose withdrawal mirror is committed;
- the projection window (`selectProjectionWindowJobs` with the retry cooldown) holds a job of a source
  that is not archived whose page is live markdown or code (`projection_work`);
- a segmented page has a projection job past its retry cooldown;
- with `abandonedBefore`, a running write or effect with no recovery was last written before it.

The probe also has work when, on a worktree the host owns: a write carries a recovery record (unless its
worktree is in `excludedRoots`); an effect carries a recovery and is due; a topology change is
recovering (unless it is in `retryingTopologies`); or a deferred write's refresh or import hold is overdue (see
"Owner scans"). A worktree row is read as described in "Worktree rows". `projection_last` is the last key window row
(`null` when the window is empty) and `high_water` is the newest job's `updated_at` text. A host id that
is not a uuid refuses with the uuid cast message.

## No-op embedding settle

`settleNoopEmbeddingEffects` (`persistence/embedding-noop-settle.ts`) settles, in bulk, queued page
embedding effects whose chunks already carry current vectors. Its four members:

- `brain.probeNoopEmbeddingSettle(from)`: whether a `queued` embedding effect with no attempts and no
  recovery has an id past `from`.
- `brain.lockNoopEmbeddingWindow({ from, limit })`: `{ newest, rows }`, the newest effect id as text,
  then the next `limit` such effects by id as `{ id, page_id }`. `page_id` reads `data.page_id` as
  `::int` does: a value that is not an integer, or one out of the integer range, refuses with the
  Postgres message. The store is single-writer, so the lock has nothing to skip.
- `brain.readNoopEmbeddingCandidates(spec)`: the window effects whose page id is in `spec.pageIds`, due
  now, with none of the data keys `targets`, `source_scan`, `retry_slugs` or `parked`, on no worktree or
  on a worktree the effect claim may take for the host (`spec.hostId`),
  with no withdrawal mirror of the request left to commit, whose page is in the effect's source, live,
  at the effect's revision with its text projection sealed there and stamped with `spec.signature`, and
  whose every chunk has a vector, `embedded_at`, an embedded text hash equal to the md5 of its text and
  the model `spec.expectedModel` (`null` matches a chunk with no model). Only the `embedding` column is
  served; another column refuses as a missing member.
- `brain.settleNoopEmbeddingRows(ids)`: each `queued` effect with no recovery among `ids` becomes
  `committed` with no error, one more attempt, no claim, outcome `{}` and the data keys `retry_slugs`,
  `target_failures` and `failing_target` removed; it returns `{ id, request_id }` for each.

## Owner scans

The write owner's housekeeping reads on each scan tick (`persistence-owner-scans.ts`). Each one joins a
write request to a worktree the host owns (see "Worktree rows"). An id that is not a uuid refuses with
`invalid input syntax for type uuid: "<id>"`; a hold kind other than `refresh` or `import` refuses.

A held write is overdue when it has waited longer than the wait limit since its last update, or longer
than four times the limit (at least four hours) since it was created. A refresh hold stands while its
refresh row (`d 0x10`) is not released and was created before the wait limit. An import hold stands while
the source exists and its `last_commit` still equals the hold's `deferred_import_from`; this engine keeps
no `last_commit`, so only an empty `deferred_import_from` stands.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listOverdueHeldWrites(hostId, maxWaitMs, hold)` | the overdue `deferred` writes on owned worktrees held by a refresh or an import, in sequence order, at most 100 | `listOverdueHeldWrites` |
| `brain.lockOverdueHold(hold, id, importFrom, maxWaitMs)` | for `refresh`, `true` while the refresh row `id` exists and is not released (a null id is `false`); for `import`, `true` while request `id` is `deferred` behind `importFrom`, its import hold stands and it is overdue (a null id or `importFrom` is `false`) | `lockOverdueHold` |
| `brain.listOwnerRecoveryHeads(hostId, excluded)` | the oldest `recovering` write of each owned worktree not in `excluded`, oldest update first, at most 16 | `listOwnerRecoveryHeads` |
| `brain.listResumableRefreshes(hostId)` | `[]`: refresh resumption has not landed here. The sync budget only marks rows stale, so it is not sent | `listResumableRefreshes` |
| `brain.getSource(id)`, once per named source | `listSourceLastCommits` answers each named source that exists, in id order; its `last_commit` reads null because the store keeps none | `listSourceLastCommits` |

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

## Worktree bindings

An unmanaged writer claim (`claimWorktree` in `src/core/persistence/ownership.ts`) records one
worktree per checkout, its paths on this host and the source that lives under it. The claim runs
through `claimWorktreeBinding(engine, body)` in `src/core/engine-sql/worktree-claim.ts`: it opens
`engine.transaction` and gives the body the transaction's `worktreeClaimStore()`. On PGLite and
Postgres that store is the module's SQL; on this engine it is the store calls below on the
transaction's handle. The transaction opens on the engine the caller holds, so a wrapper of the
engine sees it. The claim's checks (the source lock, the writer admin lock,
the overlap with this host's other worktrees and the physical-root files) stay in TypeScript. The
store keeps the three rows and refuses what the tables' keys, foreign keys and CHECKs refuse.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readOwnerHostBinding(worktreeId)` | the `local_path` of the owner host's binding of the worktree, or `null` for an unknown worktree, one with no owner, or an owner with no binding. A worktree id that is not a uuid refuses with the uuid syntax message | `readOwnerHostBinding` (effect-journal.ts `queuePublicationEffects`) |
| `brain.getWorktreeBinding(sourceId, hostId)` | the source's binding with its worktree's owner, epoch, state and `prepared_at`, and host `hostId`'s paths (null for a null or unbound host); `null` when the source is unbound | `getWorktreeBinding` |
| `brain.isSourceClaimed(sourceId)` | whether a binding names the source at its current incarnation | `isSourceClaimed` |
| `brain.listHostWorktrees(hostId)` | host `hostId`'s bindings with their worktree's owner: the claim's overlap read | the claim's overlap statement |
| `brain.readWorktree(id)`, `brain.readHostBinding(worktreeId, hostId)` | `{ owner_host_id, state }`; `{ local_path, coordination_path }`; `null` when absent | the physical-root reads |
| `brain.insertWorktree(row)`, `brain.insertHostBinding(row)`, `brain.insertSourceBinding(row)` | the row is stored with the column defaults the SQL relies on. `constraint_violation` for a taken key, an unknown worktree, or a state or Git-durability value the CHECK refuses | the claim's three `INSERT`s |
| `brain.stampWorktreeHeartbeats(hostId)` | the number of worktrees `hostId` owns, each stamped now | `stampWorktreeHeartbeats` |
| `brain.listHostRootBindings(hostId)` | one row per source bound under a worktree `hostId` binds, `topology_generation` as text | the first half of `listManagedRootBindings` |
| `brain.writerAdminStateText()` | the writer topology document as jsonb text, from one snapshot: see "Writer admin state" below | `readWriterAdminState` (`WRITER_ADMIN_STATE_SQL`) |
| `brain.preparedTransferWorktree()` | the first worktree id, in key order, that is `draining` with a manifest; `null` when none is | the writer lock's prepared-transfer check |
| `brain.readWorktreeOwner(id)` | `{ owner_host_id, owner_epoch, state, manifest }`, `owner_epoch` as text; `null` when absent | the transfer's `SELECT … FOR UPDATE` |
| `brain.readWorktreeManifest(id)` | the worktree's manifest; `null` when it has none or is absent | `readWorktreeManifest`, the accept's read before its transaction |
| `brain.worktreePublicationPending(id)` | whether a request on the worktree is `running` or `recovering` or holds a recovery record, or an effect on it holds one | the transfer's pending-publication check |
| `brain.markWorktreeDraining(id, manifest)`, `brain.reactivateWorktree(id)` | the worktree is `draining` with the manifest plus `prepared_at` (now, jsonb `timestamptz` text); `active` with no manifest. A missing worktree changes nothing; a manifest that is not an object is `invalid_argument` | the transfer prepare and cancel `UPDATE`s |
| `brain.upsertHostBinding(row)` | the host binding has the row's paths; an existing binding keeps its Git durability, a new one has none. `constraint_violation` for an unknown worktree | the accept's `INSERT … ON CONFLICT DO UPDATE` |
| `brain.contentReceiptRows(worktreeIds, hostId, sourceIds)` | one row per source bound to one of the worktrees (only `sourceIds` when not null) at its current, unarchived incarnation, with a binding on `hostId` and a `shared_skills.content.v1.<source>.<incarnation>` config row: `{ source_id, incarnation, relative_path, local_path, brain_id, key, value }`, source ids in byte order; none for a brain without an id | the content-receipt join of `rebindContentReceipts` |
| `brain.swapConfigValue(key, value, expected)` | sets the config row only while it holds `expected`; whether it did | the receipt's compare-and-set `UPDATE config` |
| `brain.acceptWorktreeOwner(id, hostId)` | `hostId` owns the worktree at the next epoch, `active`, heartbeat now; the manifest is kept. A missing worktree changes nothing | the accept's `UPDATE persistence_worktrees` |

A source binding has no foreign key to its source, as on Postgres: a removed or re-created source
leaves its binding, and the readers compare incarnations. Only a writer release deletes binding rows
("Writer release" below); no rebind or source purge runs here.

### Writer admin state

`readWriterAdminState(opts?)` and `writerAdminStore()` are the BrainEngine members of
`src/core/engine-sql/writer-admin.ts`; `writerAdminTransaction(engine, body)` there opens
`engine.transaction` and gives the body the transaction's `writerAdminStore()`. `persistence/admin-intent.ts` hashes the state text for a
reviewed `--expected-state` check (`writerAdminState`, `assertWriterAdminState`). The writer lock
(`admin-lock.ts` `writeWriterAdminLock`) and a writer transfer's prepare, accept and cancel
(`ownership.ts`) run as a `writerAdminTransaction` body over that store. An accept reads the
prepared manifest with `readWorktreeManifest` before its transaction, and rebinds the content
receipts through the store's `contentReceiptRows` and `swapConfigValue`
(`shared-skills/receipt-root.ts`). On this
engine the store's calls run on the transaction's store handle (`store-members/writer-admin.ts`).
`lockBrain` and `{ lock: true }` do nothing: the store runs one write transaction at a time, so a
state read in a transaction holds until it commits. `now()` is this process's clock in the SQL
engines' format.

The document has the SQL's keys and row shapes. Source ids, binding source ids and lock ids sort in
byte order on every engine (`COLLATE "C"` in the SQL). An empty table is `null`, as `jsonb_agg`
over no rows gives. Two parts differ from a SQL brain:

- **`brain`.** `enabled` and `mode_epoch` are the stored brain mode (`d 0x09 0x04`, "Writer
  release" below). The other columns hold their defaults: `skill_bundles_enabled` false and
  `writer_protocol_floor` 1. A store with no brain id has no row, so `brain` is `null`.
- **The digest.** Each brain has its own id, so a state reviewed on one brain never matches
  another, on any engine.

A real `gbrain sources writer claim` applies on this engine, and `writer deactivate` and
`writer activate` lift it through the writer release store ("Writer release" below).

A claim that finds a wedged reservation (its coordination lock recorded inside the checkout, #6766)
repairs it in one claim-store transaction (`persistence/coordination-lock.ts`
`repairWedgedReservation`): the store's `brainId` and `worktree` answer the brain and worktree checks
from the brain row and the worktree records.

## Writer status

`gbrain sources writer status` reads five members of `src/core/engine-sql/writer-status.ts`,
answered here by `persistence/writer_status.rs`:

- `readWriterDiagnosticRows(abandonedCutoff, excludedOrigins)`: the request, counter and claim row
  sets of the diagnostics block. A running claim untouched since the cutoff is abandoned. A cutoff
  that is not an ISO time refuses, as the SQL cast does.
- `readWriterStatusRows(hostId, sourceId)`: the source bindings with the host's root, and the
  stopped retire requests.
- `listOnboardingSources(sourceId)`: the active sources of the onboarding preflight.
- `listBlockingEffectRows(sourceId, limit, recoveringOnly)`: the effects that keep the brain from
  quiescing, by id.
- `listActiveWorktreeRefreshRows(sourceId)`: the active worktree refreshes, oldest first, with
  their deferred request count and age.

Text keys sort in byte order on every engine (`COLLATE "C"` in the SQL). Ages are whole
milliseconds, rounded as `EXTRACT(EPOCH ...)*1000` cast to bigint rounds. Three reads of the status
(stalled catch-ups, parked groups and source movement) still read raw SQL: on this engine the
first two refuse and source movement reports `not_read`.

## Writer release

`gbrain sources writer deactivate` and `activate` (`src/core/persistence/deactivation.ts`,
`activation.ts`, `pre-activation-release.ts`) and the counter charges of a topology receipt
(`topology-receipts.ts`) run on the BrainEngine members `writerReleaseStore()` and
`addPersistenceCounters(key, delta)` of `src/core/engine-sql/writer-release.ts`. On this engine the
store is `store-members/writer-release.ts`: each read is one `brain.writerReleaseRows({ kind, ... })`
call (`persistence::ReleaseRead`) with the rows of the SQL it replaces. The lock calls and `begin`
change nothing (one write transaction at a time, durable commit). `writerProtocolCount` is 0: no
writer protocol registration exists here.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.writerReleaseRows({ kind: 'blocking_requests', limit })` | the first `limit` requests that are outstanding or hold a recovery record, by sequence | `BLOCKING_REQUESTS_SQL` |
| `kind: 'recovering_topology_changes'` | the first 20 topology changes `recovering` or holding a recovery record, oldest first | `RECOVERING_TOPOLOGY_SQL` |
| `kind: 'release_effects', which` | the first 50 effects by id, `blocking` (queued, running or recovering) or `failed` (failed, no recovery record, not settled), joined to their request by its internal id | `BLOCKING_EFFECTS_SQL`, `FAILED_EFFECTS_SQL` |
| `kind: 'has_recovering_effect'` | whether an effect holds a recovery record | the deactivation's recovery check |
| `kind: 'live_leases'` | the unexpired cycle locks that are not page embedding leases, by id | `LIVE_LEASES_SQL` |
| `kind: 'live_worktree_roots'`, `'claim_roots'` | each worktree that is not retired, or each source binding, with each host root (one null root when none) | `LIVE_WORKTREE_ROOTS_SQL`, `CLAIM_ROOTS_SQL` |
| `kind: 'bound_source_ids'`, `'source_binding_count'`, `'live_bound_source_count'` | the bound source ids, their count, and the count whose incarnation is live | the binding reads |
| `kind: 'configured_sources'`, `'source_local_paths'`, `'host_binding_roots'` | the sources that are not archived (`{ id, incarnation, local_path, kind }`, by id), every source local path, every host root | `SOURCES_SQL` and the path reads |
| `kind: 'retired_deactivations'` | `[{ outcome }]` of every committed `writer_deactivate` topology change | `listRetiredDeactivations` |
| `kind: 'brain_mode'` | `{ enabled, mode_epoch }`, the epoch as text | the brain row read |
| `kind: 'audit_pages', sourceId, after, limit` | the source's live markdown pages after `after`, by slug, with `bytes` (null for a segmented body) | the activation preview's drift-audit read |
| `brain.setBrainEnabled(enabled)` | moves `mode_epoch` by one and returns it as text; the first enable records `activated_at_us`. `invalid_argument` on a store with no brain id | `ENABLE_SQL`, `DISABLE_SQL` |
| `brain.releaseWorktreeBindings(ids \| null)` | retires the named worktrees (or all), deletes every source binding and the named worktrees' host bindings (or all) | the release `UPDATE` and `DELETE`s |
| `brain.addPersistenceCounters(key, delta)` | adds each column of `delta` to counter row `key`; a missing row changes nothing; a column below zero is `constraint_violation` | `ADD_COUNTERS_SQL` |

Differences from a SQL brain: slugs and source ids sort in byte order; the store keeps no
`database_only_reason` (always null); an audit page's frontmatter size is its compact JSON text
(only the audit's 5 MB skip reads it). The engine reports `managed_persistence`, so an activated Rust
brain is written through the journal; a topology change of a managed source runs through the topology store
(below).

## Publication journal

A write to a worktree-bound source publishes its file around a request-row recovery record
(`src/core/persistence/coordinator.ts` publishMutation and recoverPublication, `journal.ts`
prepareRecovery, clearResolvedRecovery and markRecovering, `page-prepare.ts`, `ownership.ts`
guardOwnership, `effect-journal.ts`, `staging.ts` upgradeRecoveryStaging). Those reads and writes
run on the BrainEngine member `publicationJournalStore()` of
`src/core/engine-sql/publication-journal.ts`. On this engine the store is
`store-members/publication-journal.ts`: each read is one `brain.publicationJournalRows({ kind, ... })`
call (`persistence::PublicationRead`) and each write one `brain.publicationJournalWrite({ kind, ... })`
call (`persistence::PublicationWrite`). `lockSource`, `shareWorktree` and `stagingDurability` change
nothing (one write transaction at a time, durable commit); `shareWorktreeOwner` is
`brain.readWorktreeOwner(id)`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `publicationJournalRows({ kind: 'held_behind_import', sourceId, slug, sequence })` | the `deferred_import_from` of the earliest `deferred` request to the page before `sequence` whose import is the source's last commit (`''` when none), or null | compareFileTarget's held-first read |
| `kind: 'recovery_blocker', worktreeId, excludeId` | whether another request on the worktree, or an effect on it, holds a recovery record | publishMutation's recheck |
| `kind: 'owner_path', worktreeId` | the owner host's `local_path`, or null with no owner binding | the Git effect target read |
| `kind: 'recovery_staging', table, id` | `{ recovery, recovery_bytes, source_id }` of the request (uuid) or effect (number), or null | upgradeRecoveryStaging's locked read |
| `publicationJournalWrite({ kind: 'record_recovery', id, executionToken, recovery, bytes, keys, checked })` | `checked`: records and reserves only on a `running` row under the token with no record, true when it did. Otherwise reserves on `keys` and records by id and token, true when the row matched | prepareRecovery's two statements |
| `kind: 'clear_known_recovery', id, keys, recovery` | clears a terminal row's record that is still exactly `recovery` and releases its bytes; true when it did | clearResolvedRecovery's known clear |
| `kind: 'clear_recovery', id, keys, bytes` | releases `bytes` from `keys` and clears the row's record | clearResolvedRecovery's checked clear |
| `kind: 'mark_recovering', id, executionToken, reason, errorCode, errorMessage, errorDetail` | a `running` or `recovering` row under the token goes `recovering` with `reason`; the first error is kept | markRecovering |
| `kind: 'publication_started', id` | stamps `publication_started` and returns the row, or null | the publication's row stamp |
| `kind: 'block_capacity', id` | a `running` or `recovering` row with a record takes `writer_pool_capacity`; the row, or null | recoverPublication's capacity wait |
| `kind: 'block_recovery', id, reason` | a live row goes `recovering`, a terminal one keeps its state; both take `reason` | recoverPublication's refusal |
| `kind: 'requeue_recovered', id, kept, clearError` | the row goes `queued` with no claim, record or stamp; `kept` replaces the outcome; `clearError` clears the error | recoverPublication's requeue |
| `kind: 'grow_recovery_staging', table, id, recovery, extra` | replaces the record and adds `extra` to the row's `recovery_bytes` | upgradeRecoveryStaging's update |

A counter release below zero is `constraint_violation`, as the CHECK (>= 0) refuses it; a missing
counter row changes nothing. recoverPublication and upgradeRecoveryStaging move the counters through
`addPersistenceCounters` ("Writer release"). A bound write is still admitted only through
`requireManagedPersistence` (`journal.ts` admission), which this engine refuses until that
admission is typed. The owner pending-wait read in `owner-activity.ts` stays raw SQL.

## Topology store

A source lifecycle change (`src/core/persistence/source-lifecycle.ts`, `topology-locks.ts`,
`topology-clone.ts`, `topology-transaction.ts`) reads its source, worktrees, owners and pending requests through
`engine.topologyStore()` before its first write. A managed clone (`topology-clone.ts`, `topology-recovery.ts`) and
its receipts (`topology-receipts.ts`) also write through it. On PGLite and Postgres the store is the SQL in
`src/core/engine-sql/topology-store.ts`, statement for statement as the callers ran it; on this engine it
is the reads and writes below, on the handle it was taken from (a transaction's store reads and writes the
transaction, so a clone transaction's writes commit together).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.topologyLifecycleSource(sourceId)` | `{ id, incarnation, archived, local_path, config, name, last_commit }`; `null` for an unknown source | `source-lifecycle.ts`' first `SELECT … FROM sources` |
| `brain.topologySource(sourceId)` | `{ incarnation, config, last_commit, local_path }`; `null` for an unknown source | the clone's `SELECT … FROM sources` |
| `brain.topologyHostWorktrees(hostId)` | host `hostId`'s bindings with their worktree's owner, epoch and generation as text | `withTopologyLocks`' additional-root read |
| `brain.topologyMembers(worktreeIds)` | the source ids bound to the worktrees, sorted | `lockTopologyRows`' member read, `firstMember`, `anyMember` |
| `brain.topologyOwners(worktreeIds)` | `{ owner_host_id, owner_epoch, state }` per worktree, in id order | the owner `SELECT … FOR UPDATE` |
| `brain.topologyCanonicalStamp(worktreeId)` | the md5 of `id:knowledge_revision:incarnation` of every page of the bound sources, in page id order, joined with `,` | `topologyCanonicalStamp` |
| `brain.topologyUnsettledRequests(sourceIds, worktreeIds)` | the requests on the sources or worktrees that are queued, deferred, running or recovering or hold a recovery record, in sequence order | `assertTopologyRequestsSettled` |
| `brain.topologyBlockingEffect(sourceIds, worktreeIds)` | the first effect on them that is running, holds a recovery record, or is a queued `withdrawal-mirror`: `{ id, source_id }`; `null` when none | the same check's effect read |
| `brain.topologyChange(changeId)` | the topology change row (`insertTopologyChange`'s shape); `null` for an unknown id | `change`, `lockChange` |
| `brain.topologyRetireAdmissions(sourceId, incarnation, principalId, requestId)` | the other `remove` and `purge` changes of the source incarnation that are `recovering` with no recovery record, in id order | `supersedeTopologyRetires` |
| `brain.topologyUpdateWorktree(worktreeId, { kind })` | `recover` sets `state = 'recovering'`; `recover_with_manifest` also sets the manifest; `manifest` sets only the manifest (`null` clears it); `activate` sets `state = 'active'`. An unknown worktree changes nothing | the clone's `UPDATE persistence_worktrees` statements |
| `brain.topologyAdvanceGeneration(worktreeIds)` | adds 1 to each named worktree's generation once (a repeated id counts once), then gives each source binding of those worktrees its worktree's generation | `advanceTopology` |
| `brain.topologyUnbindSource(sourceId, incarnation)` | deletes the source's binding when it names that incarnation | the release's binding `DELETE` |
| `brain.topologyInsertSource({ id, name, localPath, config, incarnation })` | stores a new source with the given incarnation; a taken id or name refuses `constraint_violation` and writes nothing | the clone commit's `INSERT INTO sources` |
| `brain.topologyResetSourceCheckpoint(sourceId, incarnation)` | clears `last_commit` and `last_sync_at` when the source has that incarnation | the reclone commit's checkpoint reset |
| `brain.topologyUpdateChange(changeId, { kind })` | the updated row, or `null` when the id is unknown or the guard fails. `save_recovery` needs `state = 'recovering'`; `commit` sets `committed` and `outcome = outcome \|\| $2` (a null outcome stays null, as in SQL); `release` sets the state (one of the topology states, else it refuses), clears the recovery and `recovery_bytes`, and merges the outcome onto `{}`; `clear_recovery` clears the recovery, `recovery_bytes` and `intent_bytes`; `settle_retire` needs a `recovering` change with no recovery record and sets state, outcome and `terminal_bytes` (negative refuses) | `saveCloneRecovery`, `commitChange`, `releaseChange`, `clearChangeRecovery`, `settleRetire` |

The outcome merges follow jsonb `||`: two objects merge with the right side's keys winning, arrays concatenate,
and any other pair is the array of both.

`durable`, `syncCommit`, `lockBrain`, `lockSources` and `sharePrincipal` do nothing, and `lockChange` is `change`: a store commit is
durable before it returns and the store runs one write transaction at a time, so the commit setting,
the wait bounds and the row locks change nothing. `activeRefresh` is always `null`: this engine keeps no
worktree refresh rows (`gbrain sources refresh` refuses before it writes one). `hostLocalPaths`,
`hostBinding` and `lockedSource` are served from `listHostWorktrees`, `readHostBinding` and
`topologySource`. `brainId` is `readPersistenceBrainId`; `worktree` is `readWorktree`;
`insertCloneWorktree`, `bindCloneSource` are `insertWorktree` and `insertSourceBinding`; `bindCloneHost` reads the
host binding first and keeps an existing one, as `ON CONFLICT DO NOTHING` does. `markTopologyChange` does nothing: no
trigger guards this engine's source records. The receipts' counter changes go through `addPersistenceCounters`.
A managed clone commits on this engine, and the owner's recovery finishes or rolls back an interrupted clone or
reclone here too. This engine resumes no worktree refresh: `listResumableRefreshes` ignores the refresh keyspace,
and no shipped path writes or imports a refresh row (docs/designs/RUST_ENGINE.md, row L7-1).

## TypeScript members with no stored state

| Member | Answer | Why |
| --- | --- | --- |
| `readLedgerSource(sourceId, opts?)` | `{ incarnation, purgeEpoch: 0, coverage: null, purgesPossible }`, `purgesPossible` true when the source holds a fact purge tombstone (`hasFactPurges`, rust/docs/store/facts.md "The fact purge ledger"); a batch adds `managedRows: [{ enabled }]` (the stored brain mode, "Writer release") and `planModePrev: 'auto'` | Belief events, the purge epoch and take and page purges are written only through `executeRaw`, which this engine refuses. |
| `listHostConsumerRows(hostId, opts?)`, `probeLiveConsumerRows(probe, opts?)` | `[]` | One process owns this engine's brain, so it keeps no consumer heartbeat rows. PGLite, which also admits one process, answers the same in its callers (`listHostConsumers`, `probeLiveFullConsumer`) without a read. |
| `renewConsumerRow(renewal, opts?)`, `deleteConsumerRow(key, opts?)` | resolve with no effect | The heartbeat has no row to renew or delete. `stampWorktreeHeartbeats` is served; see "Worktree bindings". |
| `lockEffectGuard(worktreeId)` | resolves `null` | The store is single-writer, so the brain-row share lock has nothing to wait on, and this engine has no worktree to read. A worktree id that is not a uuid refuses with the uuid syntax message. |
| `requireSynchronousCommit()` | resolves with no effect | A store commit makes every write durable before it returns (`kv.rs` `commit`), so there is no asynchronous commit to turn off. |
