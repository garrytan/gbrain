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
| `d 0x02 <op> 0x00 <fingerprint>` | one housekeeping `op_checkpoints` row, JSON |
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
| `brain.completeWriteRow(completion)` | the ended row (with `purge_has_facts`, `purge_has_pages` when `probePurges`), or `null` when the result and the request's effects do not fit the reservation. The whole reservation stays charged while an effect is unfinished; otherwise the result and effect bytes are kept. Releases the counters; a terminal counter shorter than the release is clamped to zero and counted in config `persistence.true_up.clamped`. A completion that would take a counter below zero changes nothing and rejects with `constraint_violation` | `completeWriteRow` |
| `brain.releaseUnpublishedClaim({ id, token, reason, charge })` | `true` when the request was `running` under that token with no recovery record and no publication begun; it is back in `queued` with `reason` as its blocked reason, no token and no lease. `charge` counts one preparation attempt and keeps the claim phase; otherwise the phase is cleared | `releaseUnpublishedClaim` |
| `brain.renewWriteClaim({ id, token, leaseMs, phaseJson })` | `true` when the claim is still `running` under that token; the lease is extended and the phase replaced when one is given | `renewWriteClaim` |
| `brain.expireStaleWriteClaims({ hostId, charge, deadOwners })` | the number of claims returned to `queued`: an expired lease, or a phase owner in `deadOwners` (`pid:nonce:start`), with publication not started; at most 100, oldest first. `charge` counts one preparation attempt for a claim that expired while preparing | `expireStaleWriteClaims` |
| `brain.hasClaimableWrite({ excludeRoots, priority })` | whether a claim would find a row now. `priority` `null` reads config `sync.foreground_priority` (on unless `0` or `false`) | `hasClaimableWrite` |
| `brain.selectClaimableWrite({ excludeRoots, fifoRoots, laneRoots, priority })` | the request row a FIFO claim takes next, or `null`: a foreground row before the sync rows it passes, then sequence order. A root in `fifoRoots` claims plain FIFO; with any lane root only a foreground row is claimed | `selectClaimableWrite` |
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
| `brain.listTrueUpRequests(ids)` | the true-up candidates; effect bytes and the unfinished flag are read from the request's `persistence_effects` rows (`effects::effect_totals`) | `listTrueUpRequests` |
| `brain.readCapacityForecastInputs(light)` | the counters, the per-day rows (the principal rows, then the lifecycle receipts grouped by writer and UTC day), the history and, unless `light`, the reclaim rows. `tableBytes` is `null` (no relation size) | `readCapacityForecastInputs` |
| `brain.listPendingSegmentedProjections(filter)` | the queued jobs of segmented pages that a projector can take now, as `listPendingSegmentedProjections` returns them | `listPendingSegmentedProjections` |
| `brain.selectProjectionWindowJobs(cursor, retryCooldown)` | the window rows (the recency lane, then the wrapped key-order lane), with `high_water` as Postgres prints a `timestamptz`; the one row of nulls for an empty queue | `selectProjectionWindowJobs` |

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
`persistence_effects` to the worktrees the host owns. This engine keeps no worktree and claims no
effect yet (see "Publication effects"), so each scan answers no row. The arguments are checked as the Postgres casts check them: a host
id that is not a uuid refuses with `invalid input syntax for type uuid: "<id>"`, an `after` that is
not a bigint with `invalid input syntax for type bigint: "<after>"` (or `value "<after>" is out of range
for type bigint`), a fractional limit with the same bigint syntax message and a negative limit with
`LIMIT must not be negative`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listGatedMirrorRequests(hostId)` | `[]`: no withdrawal mirror is parked on a worktree here. The gate and allowed codes change nothing, so they are not sent | `listGatedMirrorRequests` |
| `brain.listEffectRecoveries(hostId, after, limit)` | `[]`: no effect carries a recovery on a worktree here | `listEffectRecoveries` |
| `brain.selectClaimableEffect(hostId)` | `null`: a stored effect waits `queued`, because this engine runs no effect yet. The dead owner keys change nothing, so they are not sent | `selectClaimableEffect` |

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

No effect is claimed or run on this engine yet: `selectClaimableEffect` answers `null` (see "Effect
scans"), so every stored kind, embedding included, waits `queued` and nothing is lost. The receipt
names a row that exists, and the write's reservation stays charged until the effect ends.

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
| `readLedgerSource(sourceId, opts?)` | `{ incarnation, purgeEpoch: 0, coverage: null, purgesPossible: false }`; a batch adds `managedRows: [{ enabled: false }]` and `planModePrev: 'auto'` | Belief events and fact, take and page purges are written only through `executeRaw`, which this engine refuses. |
| `listHostConsumerRows(hostId, opts?)`, `probeLiveConsumerRows(probe, opts?)` | `[]` | One process owns this engine's brain, so it keeps no consumer heartbeat rows. PGLite, which also admits one process, answers the same in its callers (`listHostConsumers`, `probeLiveFullConsumer`) without a read. |
| `renewConsumerRow(renewal, opts?)`, `deleteConsumerRow(key, opts?)`, `stampWorktreeHeartbeats(hostId, opts?)` | resolve with no effect | The heartbeat has no row to renew or delete, and this engine has no worktrees to stamp. |
| `requireSynchronousCommit()` | resolves with no effect | A store commit makes every write durable before it returns (`kv.rs` `commit`), so there is no asynchronous commit to turn off. |
