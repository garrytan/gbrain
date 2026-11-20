# Repair bookkeeping

The engine members the bookkeeping repair kinds call (`src/core/engine-sql/repair-bookkeeping.ts`,
plus `listSourceIncarnations` in `engine-sql/sources.ts`): `gbrain repair orphan-bindings`,
`loop-facts` and `connector-checkpoints`, and the doctor checks of the same names. The
managed-sync-orphan and owned-content members (`engine-sql/managed-sync-orphans.ts`,
`engine-sql/owned-content.ts`; Rust side `store-members/managed-sync-orphans.ts`) have their own
sections below. The SQL engines run
the statements those files ran through `executeRaw`; a Rust brain serves each member from what the
store keeps (`src/core/rust-engine/store-members/repair-bookkeeping.ts`).

| Member | SQL engines | Rust brain |
| --- | --- | --- |
| `listSourceIncarnations(ids)` | `{ id, incarnation }` of each named source, by `id COLLATE "C"` | `readSourceIncarnation` per distinct id, by id in code-unit order; a missing source is left out |
| `listOrphanBindings({ limit })` | writer bindings whose source is gone or whose incarnation changed, with their pending requests | `[]`: the store keeps no writer bindings (a Rust brain is never managed) |
| `deleteOrphanBinding(binding)` | deletes the binding when it is still an orphan | `false`: no binding exists |
| `readLoopFactState(loopId, { lock })` | the loop, its commitment fact and whether another open loop holds the fact; `lock` adds `FOR UPDATE` | `facts::loops` `read_loop_fact_state`; `lock` is moot, as the store serializes writes |
| `expireSourceFactNow(factId, sourceId)` | expires one unexpired fact of the source now | `facts::loops` `expire_source_fact_now` (`rust/docs/store/facts.md`, "Open loops") |
| `listConnectorSources({ lock })` | every source whose `config.kind` is a connector kind; `lock` share-locks them in id order | `listSourceRecords` filtered on the connector kinds, with `readSourceIncarnation`; `lock` sorts by id |
| `listOrphanConnectorCheckpoints(loadable, bounds, limit)` | the orphan predicate below, by op then fingerprint | `persistence::connector_orphans` |
| `countConnectorCheckpointsKeyed(keys)` | checkpoint rows keyed by one of the keys (retry rows by `checkpointKey`) | `persistence::connector_orphans` |
| `deleteOrphanConnectorCheckpoint(row, loadable, bounds)` | deletes the row when its stamp is unchanged and it is still an orphan | `persistence::connector_orphans` |

## Orphan connector checkpoints

A connector checkpoint is an `op_checkpoints` parent (`persistence.md`, "Op checkpoints") of op
`managed-connector`, keyed by its fingerprint, or `managed-connector-retry`, keyed by
`completed_keys[0].checkpointKey`. It is an orphan when all of these hold:

- its key is not in `loadable`;
- no pending connector request names it. A request is pending when it is outstanding (`queued`,
  `deferred`, `running`, `recovering`) or in recovery, and is a connector request when its
  `intent.kind` starts with `connector_v2_` or `managed_connector_`. A request names the row when its
  `intent.checkpointKey` is the fingerprint or the row's `checkpointKey`, or its request id is the
  row's `completed_keys[0].requestId`;
- no request of any state that a `stateOp` row lists in `completed_keys[0].pending[]` (by
  `requestId`) names it the same way;
- its stamp is not after `before`, and is older than `minAgeDays` days when that is given.

`updated_at` is the stamp as Postgres `timestamptz::text` in UTC (`2026-11-18 07:46:03.336+00`). The
delete reads its `updated_at` and `before` as `timestamptz`: the store accepts that form and ISO 8601,
and refuses other text with `invalid_argument`.

Differences from the SQL engines:

- Postgres orders the scan by the database collation; the store orders by bytes.
- Postgres raises an error when a `stateOp` row's `pending` is present and not an array
  (`jsonb_array_elements` of a scalar); the store reads it as no pending requests.
- `minAgeDays` is a whole number of days from the store clock; Postgres reads `now()`, the start of
  the transaction.
- The delete runs in one store write, so the orphan test and the delete see the same rows, as the
  share lock and `FOR SHARE` give on Postgres.

What still runs through `executeRaw` and so refuses on a Rust brain: `migrateConnectorCheckpoints`
(migration 176) and `readConnectorV2Cutoff`.

## Managed-sync orphans

`gbrain repair managed-sync-orphans` (`src/core/persistence/managed-sync-orphans.ts`) and the
failure-ledger prune read and retire the managed-sync `op_checkpoints` rows: `managed-sync` cursors,
`managed-sync-pass` rows, `managed-sync-failure` rows and `managed-sync-manifest` rows.

| Member | SQL engines | Rust brain |
| --- | --- | --- |
| `listManagedSyncOrphanRows(sourceIds)` | the cursors, failures, retired cursors and pass rows, each with the flags the classifier reads | the same predicates evaluated over `listOpCheckpointRecords`, `listSourceRecords`, `listSourceRequestRows` and the local writers |
| `listArchivedSourceIds()` | ids of archived sources | `listSourceRecords` with `archived` |
| `listManagedSyncFailureKeys(keys)` | the keys that have a `managed-sync-failure` row | `readOpCheckpointRecord` per key |
| `applyManagedSyncRetireLimits()` | `synchronous_commit` on and a 2-second `lock_timeout`, for the transaction | no-op |
| `retireManagedSyncPassSlugMode(target, lockId)` | drops `obligations.slug_mode` from the pass row while its refusal holds and no pass holds the drain lease | the same test; the lease is `readCycleLocks({ by: 'id' })`, the write `writeOpCheckpointRecord` |
| `retireManagedSyncCursor(target, mode)` | deletes the unfinished cursor when its pending request is not live and the mode's re-check holds | the same test, then `deleteOpCheckpoint` |
| `deleteManagedSyncFailureRow(key, retired)` | deletes the failure row while no cursor shares its key | the same test, then `deleteOpCheckpoint` |
| `deleteManagedSyncManifest(runId)` | deletes the manifest while no cursor names the run | the same test, then `deleteOpCheckpoint` |

`listSourceRequestRows(sourceId)` (`persistence::sync_orphan_reads`) lists one source's requests by
sequence with the columns the predicates read; `recovery` is whether the request has a recovery
record. `listOpCheckpointRecords(op)` lists one op's parents by fingerprint with `updated_at_us`,
the stamp in microseconds that the listing sorts on.

Differences from the SQL engines:

- Postgres orders the listing by `s.id`, `c.updated_at`, `c.fingerprint` in the database collation;
  the store orders ids and fingerprints by bytes.
- Postgres casts JSON text with `::int` and `::uuid` and raises an error on text that is not a number
  or a UUID. The store reads such text as no match. A retire whose pending `requestId` is not a UUID
  keeps the cursor (fail-closed), as Postgres does when its statement fails.
- `->>` of a JSON value that is not a string is its JSON text, as on Postgres.
- `FOR UPDATE`, `lock_timeout` and `synchronous_commit` are moot: each member's test reads the store
  and its write is one store call.
- A cursor's writer principal is live when the store's local writers list it.
- `clearSyncSlice` still runs through `executeRaw`, so a retire that clears a sync slice refuses
  `raw_sql` on a Rust brain and its transaction rolls back. A Rust brain is never managed, so it has
  no managed-sync rows to retire.

## Owned content

`listOwnedContentRows` (`shared-skills/content-freshness.ts`), `readContentReceiptBinding` and
`readConfigForUpdate` (`repair/content-receipt-root.ts`) read which sources a writer binding owns,
the binding behind a content receipt and a config value under `FOR UPDATE`. A Rust brain keeps no
writer bindings, so it owns no content: `listOwnedContentRows` answers `[]` and
`readContentReceiptBinding` answers `null`. `readConfigForUpdate` is `getConfig`, as the store
serializes writes.
