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

A counter key is the text of `persistence_counters.key` (`brain`, `principal:<kind>:<id>`).

The `J` record is a superset of `journal::RequestRecord`, by design. A request row that
`insertWriteRequest` stored keeps every `persistence_requests` column: the columns the native journal
reads are named fields, the others are in the record's `extra` map with their table defaults. The
native write path decodes the named fields and keeps `extra` as it found it, so both writers share one
key and one record. A record the native write path stored reads back with those defaults filled in.

A queue key holds the incarnation as its 36-byte lower-case UUID text, so key order is
`(source_incarnation, slug)` order, the order of the Postgres primary key.

## Methods

Each method is one store write transaction (or one read). The row locks Postgres takes for these
statements (`FOR SHARE`, `FOR UPDATE`, `SKIP LOCKED`), the advisory locks and the page write guards are
no-ops: the store runs one write transaction at a time, so no read overlaps a write.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.lockPersistenceCounters(keys)` | the counter rows `{ key, outstanding_count, intent_bytes, lifetime_ids, terminal_bytes }`, sorted by key; a missing row is created at zero | `lockPersistenceCounters` |
| `brain.insertWriteRequest(row)` | the stored `WriteRequest`. It charges each counter (one outstanding request, its intent bytes, one lifetime id, its terminal reservation) in the same write. `constraint_violation` for a principal kind, state, target kind or protocol version the table refuses, a null slug, a worktree or refresh id (this engine keeps no worktrees), or a request id the principal already used; `invalid_argument` for a principal id holding a NUL byte | `insertWriteRequest` |
| `brain.readWriteRequest({ kind, id }, requestId)` | the `WriteRequest` or `null` | `readWriteRequest` |
| `brain.readWriteRequestById(id)` | the `WriteRequest` or `null` | `readWriteRequestById`, `lockWriteRequest`, `readWriteRequestProgress` (the TS member picks the nine progress columns from this row) |
| `brain.countOutstandingBySource(principalKind, principalId)` | `[{ source_id, n }]`: one row per source that holds requests of the principal in state `queued`, `deferred`, `running` or `recovering`. The most requests come first; a tie is in byte order of the source id, as Postgres sorts `COLLATE "C"` | `countOutstandingBySource` |
| `brain.readCounterRows(keys)` | the `persistence_counters` rows that exist for the keys, in byte order of the key, without creating or locking any; a missing key has no row | `readCounterRows` |
| `brain.readAdmissionRate(principalKind, principalId)` | `{ first_request_id, admissions, age_seconds, gross, net }`: the id of the brain's first request (lowest sequence), then over the latest 1000 requests of the principal (all principals when both are null) their count, the age in seconds of the oldest of them, the mean terminal reservation and the mean compacted receipt size (authority, outcome, error detail and client request id, plus each of its effects' data and kind and 1 KiB of headroom, at most the reservation). The means and the age are null when there are no requests | `readAdmissionRate` |
| `brain.stampWriteClaim({ id, token, leaseMs, phaseJson })` | the claimed row with `passed_sync` and `seen_sequence`, or `null` when the refresh barrier holds it | `stampWriteClaim` |
| `brain.completeWriteRow(completion)` | the ended row (with `purge_has_facts`, whether the source holds a fact purge tombstone, and `purge_has_pages`, always false, when `probePurges`), or `null` when the result and the request's effects do not fit the reservation. The whole reservation stays charged while an effect is unfinished; otherwise the result and effect bytes are kept. Releases the counters; a terminal counter shorter than the release is clamped to zero and counted in config `persistence.true_up.clamped`. A completion that would take a counter below zero changes nothing and rejects with `constraint_violation`. The outcome and error detail are stored with their object keys in jsonb order (shorter keys first, then bytes, at every depth), as a `jsonb` column keeps them | `completeWriteRow` |
| `brain.cancelWriteRow(cancellation)` | `null` when the request does not exist; `{ status: 'kept', row }` with the row unchanged when it is terminal, publishing, in recovery, or no longer in `expectState` under `expectExecutionToken`; `{ status: 'too_large', row }` when the result does not fit the reservation; else `{ status: 'cancelled', row }` with the row `completeWriteRow` ends. The read, the check and the completion run in one store write, so of two cancels of one request exactly one ends it. A state other than `cancelled` rejects with `constraint_violation` | `cancelWriteRow` |
| `brain.releaseUnpublishedClaim({ id, token, reason, charge })` | `true` when the request was `running` under that token with no recovery record and no publication begun; it is back in `queued` with `reason` as its blocked reason, no token and no lease. `charge` counts one preparation attempt and keeps the claim phase; otherwise the phase is cleared | `releaseUnpublishedClaim` |
| `brain.renewWriteClaim({ id, token, leaseMs, phaseJson })` | `true` when the claim is still `running` under that token; the lease is extended and the phase replaced when one is given | `renewWriteClaim` |
| `brain.expireStaleWriteClaims({ hostId, charge, deadOwners })` | the number of claims returned to `queued`: an expired lease, or a phase owner in `deadOwners` (`pid:nonce:start`), with publication not started; at most 100, oldest first. `charge` counts one preparation attempt for a claim that expired while preparing | `expireStaleWriteClaims` |
| `brain.hasClaimableWrite({ excludeRoots, priority })` | whether a claim would find a row now. `priority` `null` reads config `sync.foreground_priority` (on unless `0` or `false`) | `hasClaimableWrite` |
| `brain.selectClaimableWrite({ excludeRoots, fifoRoots, laneRoots, priority })` | the request row a FIFO claim takes next, or `null`: a foreground row before the sync rows it passes, then sequence order. A root in `fifoRoots` claims plain FIFO; with any lane root only a foreground row is claimed | `selectClaimableWrite` |
| `brain.readSourceMembership(sourceId)` | `{ incarnation, archived }` or `null` | `readSourceMembership`, `readLedgerSource` |

Rows have a null `worktree_id`, so the worktree terms of the claim statements are answered as Postgres
answers them for a null worktree. `select_claimable_write` (the claim head read) exists in the store
but has no binding.

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

Differences from the SQL engines:

- The SQL read names no order; the store lists the paths in path order. `resumeFilter` and every caller
  use the keys as a set.
- `purgeStaleCheckpoints` (the cycle's 7-day purge) is still raw SQL, which this engine refuses, so a
  checkpoint that no run clears stays until an op clears it.
- The other `op_checkpoints` writers (sync identity downgrades, sync holds, fence repair, the
  persistence receipts) are still raw SQL. Their rows are not in this store.
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
| `brain.recentWriterVersions(days)` | the committed requests published in the last `days`, grouped per role, host, principal and version with a `requests` count; admitters count from the cutoff by admission, consumers by publication; newest first | `recentWriterVersions` |

## Effect scans

The effect worker's reads before and when it claims effects (`persistence-effect-scans.ts`). Each one joins
`persistence_effects` to the worktrees the host owns. This engine keeps no worktree, so the two
recovery scans answer no row; the claim read answers the next effect (see "Effect worker"). The arguments are checked as the Postgres casts check them: a host
id that is not a uuid refuses with `invalid input syntax for type uuid: "<id>"`, an `after` that is
not a bigint with `invalid input syntax for type bigint: "<after>"` (or `value "<after>" is out of range
for type bigint`), a fractional limit with the same bigint syntax message and a negative limit with
`LIMIT must not be negative`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listGatedMirrorRequests(hostId)` | `[]`: no withdrawal mirror is parked on a worktree here. The gate and allowed codes change nothing, so they are not sent | `listGatedMirrorRequests` |
| `brain.listEffectRecoveries(hostId, after, limit)` | `[]`: no effect carries a recovery on a worktree here | `listEffectRecoveries` |
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
foreign key), and so does an effect with no kind or no data. Nothing is stored on a refusal.

`brain.readRequestEffects(requestId, kind)` resolves `{ kind, state, error_code, outcome, recovering }` for
each stored effect of the request in kind order, or only its `kind` effect when one is named (`readRequestEffects`,
the reads a write receipt makes). A request id that is not a uuid refuses with the uuid syntax message.

The effect worker claims and settles these rows (see "Effect worker"). The receipt names a row that
exists, and the write's reservation stays charged until the effect ends.

## Withdrawal effects

`brain.insertWithdrawalEffects({ requestId, sourceId, data })` queues the effects a forget under a write
request leaves (`insertWithdrawalEffects`, the statement `recordFactWithdrawal` sent through `executeRaw`):
one `withdrawal-mirror`, `git` and `embedding` row, in that order, each `queued` with `data`, a null
revision, the source's incarnation and a null worktree (no worktree binds a source here). It resolves the
kinds it inserted. An unknown source inserts nothing, as the statement's `FROM sources` yields no row; a
kind already stored for the request is kept. A request id that is not a uuid refuses with the uuid syntax
message, and a request with no row refuses `constraint_violation` (the foreign key). Inside `transaction`
it is one more write of the withdrawal's store write, so the effects commit with the withdrawal.

## Effect worker

The statements the effect worker sends to claim one effect and to settle its claim
(`persistence-effect-worker.ts`), with the PostgreSQL rules. The store is single-writer, so a read
takes no row lock, and a Rust brain has no worktrees.

`brain.selectClaimableEffect(hostId, deadOwners)` resolves the effect row with the lowest
(`next_attempt_at`, id) that is `queued`, `running` with an expired claim, or `running` under a dead
owner (`deadOwners` holds `pid:nonce:start` keys; the claim's `host_id` must be `hostId`), that is due
now, on no worktree and not recovering, and that is a withdrawal mirror or belongs to a request with no
`queued` or `running` withdrawal mirror. It resolves `null` when no effect is claimable.

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

- a queued write is claimable (the claim rules above, with `excludedRoots` and `laneRoots`) and is
  not blocked for writer pool capacity, unless `publishing` is set;
- a running write that has not published, with no recovery, has an expired claim;
- an effect is due as the probe states it: `queued`, or `running` with an expired claim, due now, on no
  worktree, not recovering, and a withdrawal mirror or of a request whose withdrawal mirror is committed;
- the projection window (`selectProjectionWindowJobs` with the retry cooldown) holds a job of a source
  that is not archived whose page is live markdown or code (`projection_work`);
- a segmented page has a projection job past its retry cooldown;
- with `abandonedBefore`, a running write or effect with no recovery was last written before it.

The worktree recovery, effect recovery on a worktree, topology recovery and overdue deferred terms join
a worktree, and a Rust brain has none, so they find no row. `projection_last` is the last key window row
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
  now, with none of the data keys `targets`, `source_scan`, `retry_slugs` or `parked`, on no worktree,
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
write request to a worktree the host owns. This engine keeps no worktree (a request here always has a
null `worktree_id`, and an insert that names a refresh hold refuses), so each list answers no row and no
hold stands. An id that is not a uuid refuses with `invalid input syntax for type uuid: "<id>"`; a hold
kind other than `refresh` or `import` refuses.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listOverdueHeldWrites(hostId, hold)` | `[]`: no write here waits behind a refresh or a worktree import. The wait limit only narrows the rows, so it is not sent | `listOverdueHeldWrites` |
| `brain.lockOverdueHold(hold, id)` | `false`: no refresh row or worktree import hold exists here. `id` is the refresh id (may be null) or the request id | `lockOverdueHold` |
| `brain.listOwnerRecoveryHeads(hostId)` | `[]`: no write here carries a recovery record (those live only on worktree-owned writes). The excluded worktree ids only narrow the rows, so they are not sent | `listOwnerRecoveryHeads` |
| `brain.listResumableRefreshes(hostId)` | `[]`: no refresh row exists here (refreshes live only on managed worktrees). The sync budget only marks rows stale, so it is not sent | `listResumableRefreshes` |
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

## TypeScript members with no stored state

| Member | Answer | Why |
| --- | --- | --- |
| `readLedgerSource(sourceId, opts?)` | `{ incarnation, purgeEpoch: 0, coverage: null, purgesPossible }`, `purgesPossible` true when the source holds a fact purge tombstone (`hasFactPurges`, rust/docs/store/facts.md "The fact purge ledger"); a batch adds `managedRows: [{ enabled: false }]` and `planModePrev: 'auto'` | Belief events, the purge epoch and take and page purges are written only through `executeRaw`, which this engine refuses. |
| `listHostConsumerRows(hostId, opts?)`, `probeLiveConsumerRows(probe, opts?)` | `[]` | One process owns this engine's brain, so it keeps no consumer heartbeat rows. PGLite, which also admits one process, answers the same in its callers (`listHostConsumers`, `probeLiveFullConsumer`) without a read. |
| `renewConsumerRow(renewal, opts?)`, `deleteConsumerRow(key, opts?)`, `stampWorktreeHeartbeats(hostId, opts?)` | resolve with no effect | The heartbeat has no row to renew or delete, and this engine has no worktrees to stamp. |
| `lockEffectGuard(worktreeId)` | resolves `null` | The store is single-writer, so the brain-row share lock has nothing to wait on, and this engine has no worktree to read. A worktree id that is not a uuid refuses with the uuid syntax message. |
| `requireSynchronousCommit()` | resolves with no effect | A store commit makes every write durable before it returns (`kv.rs` `commit`), so there is no asynchronous commit to turn off. |
