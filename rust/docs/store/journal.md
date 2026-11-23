# The brain store: The write journal

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

`submitPageMutation` is the write path for pages: admit, apply and commit in one transaction, so a
page, its chunks and postings, the version snapshot of what it replaced and the committed request
are all there after a crash or none of them are. It ports the semantics of
`src/core/persistence/` (`journal.ts`, `page-mutations.ts`, `identity.ts`), not its SQL. There are no
leases, claims, recovery records, worktree fences or refresh deferral: one process owns the brain
and one write runs at a time, and nothing here publishes files.

A request is identified by `(principal.kind, principal.id, requestId)`. `requestId` is a UUID (absent:
the store mints one; a client's non-UUID id goes in `clientRequestId`). Repeating a request with the same
content returns the stored receipt and writes nothing; other content is `idempotency_conflict`. The
digest covers the operation, source, slug and the page and options as sent. Each principal may have 100
unfinished requests and the brain 1000 (`admission_refused`; `limits` overrides them). A request ends
once, in `committed`, `conflict`, `failed` or `cancelled`; `deferred` and `recovering` are accepted
states a receipt reader may meet but nothing here enters them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.submitPageMutation({ principal, requestId?, clientRequestId?, sourceIncarnation?, slug, page, options?, authority? }, limits?)` | the receipt. `state: "committed"` with `status` (`created`, `updated`, `unchanged`), `slug`, `page_id`, `source_id`, `knowledge_revision`, `content_hash`, `chunks`, `version_id`. A write that fails on its own terms (`revision_conflict`, `revision_required` end `conflict`; `empty_overwrite`, a bad chunk or date end `failed`) changes nothing, resolves a receipt with `write_error` and `write_error_message`, and returns that same receipt when repeated. `invalid_argument`, `invalid_slug`, `source_not_found`, `source_changed`, `idempotency_conflict`, `admission_refused` and `store_*` reject and record nothing | `submitPageMutation` |
| `brain.admitWrite(admission, limits?)` | the stored `WriteRequest` (`id, principal_kind, principal_id, request_id, client_request_id, operation, source_id, source_incarnation, page_id, slug, digest, intent, authority, sequence, state, outcome, error_code, error_message, blocked_reason, compacted, created_at, updated_at, completed_at`); `queued` when new, the stored one when repeated | `admitWrite` |
| `brain.getWriteRequest(principal, requestId)` | the `WriteRequest` or `null` | `getWriteRequest` |
| `brain.getWriteReceipt(principal, requestId)` | the receipt (`outcome` fields, `outcome`, `request_id`, `client_request_id?`, `state`, `write_error?`, `write_error_message?`, `blocked_reason?`, `created_at`, `updated_at`) or `null` | `receiptFor` |
| `brain.finishWrite(principal, requestId, { state, outcome?, errorCode?, errorMessage?, blockedReason? })` | the receipt; `invalid_state` for a request that already ended or a non-terminal state | none |
| `brain.journalOutstanding()` | `{ brain, principals }`, unfinished requests | none |
| `brain.getBrainIdentity()` | `{ brain_id }` | `readBrainIdentity` |
| `brain.registerLocalWriter({ id, lane, credentialHash, grantCeiling? })` | the writer row `{ id, lane, credential_hash, grant_ceiling, created_at, revoked_at }`. Idempotent; `writer_rejected` for a revoked row, another lane or credential under the id, or a credential registered under another id | `registerLocalWriterValue` |
| `brain.readLocalWriter(id)` | the writer row or `null` | `verifyLocalWriter` read |
| `brain.insertLocalWriterRow({ id, lane, credentialHash, grantCeiling? })` | `true` when this call stored the row; `false`, with nothing written, when a row already holds the id or the credential hash, whatever that row's lane, revocation or grant. A non-UUID id or a lane other than `cli` or `stdio` rejects with `invalid_argument` | the `INSERT .. ON CONFLICT DO NOTHING` of `insertLocalWriterRow` |
| `brain.revokeLocalWriter(id)` | `true` when the registration exists | `revokeLocalWriter` |

The credential itself never reaches the store: callers pass its SHA-256. `write_error_message` and
`journalOutstanding` are additions; the TypeScript receipt keeps a separate failure detail row that
this engine does not have.

## TypeScript journal members

`src/core/rust-engine/store-members/persistence.ts` answers these BrainEngine members on a Rust brain.
Each returns what PGLite returns for a brain with the same contents.

| Member | Answer | Why |
| --- | --- | --- |
| `readManagedModeRows()` | `[{ enabled: false }]` | The store keeps no managed brains, so a brain here is always unmanaged. |
| `readLocalWriterRow(id, opts?)` | the row from `brain.readLocalWriter`, with `revoked_at` as a `Date`, or `undefined` | `lock` changes nothing: one write transaction runs at a time, so a read never overlaps a revocation. |
| `insertLocalWriterRow(row)` | `brain.insertLocalWriterRow` | The same two unique keys as PGLite's table. |
| `revokeLocalWriterRow(id)` | `brain.revokeLocalWriter` | An earlier revocation time stays; `false` when no registration has the id. |
| `readJournalLimitRows()` | the config keys that start with `persistence.limits.`, the page-body keys, then `{ key: null, value: null }` | The store keeps no segmented pages, so the largest one has no size. |
| `readHeldPageRows(pageIds)`, `readHeldCoverageRows(sourceIds)`, `readGitHoldRecords(opts)` | `[]` | The store holds no files from a sync, so nothing is held. `readGitHoldRecords` is the git sync hold read of `persistence/sync-holds.ts` `readGitSourceHolds`; its SQL lives in `src/core/engine-sql/sync-hold-reads.ts`. |
| `listFenceHoldRows(sourceIds, kinds, ownerKey?)` (`src/core/rust-engine/store-members/fence-holds.ts`) | `brain.listFenceHoldRows` | The held facts and takes fence rows of the derived generation family ([generations.md](generations.md)), oldest first, with `created_at` as Postgres `timestamptz` text. |
| `readFenceOriginGone(sourceId, slug)` (same file) | page read | Whether the page is deleted or gone, from `readPageSnapshot` with deleted pages, by exact slug. |
| `lockGenerationKey(lockKey)` (same file) | no-op | A transaction holds the store's writer gate from open to commit, so the store's write is the generation key lock. |
| `clearFenceHoldRows(key)` (same file) | `brain.clearFenceHoldRows` | Deletes the key's held row when its reason is `fence_absent` or `no_proof`. |
| `readFenceHoldFiles(sourceIds, slugs)` (same file) | page reads | One `readPageSnapshot` per source and slug; `database_only` when the page records no `source_path`. |
| `readSourcePurgeEpoch(sourceId)` | the stored purge epoch for a known source, `null` otherwise | The member reads the source record's `purge_epoch` through `brain.readSourcePurgeEpoch` (0 until a purge raises it; see [sources.md](sources.md)). On PGLite and Postgres the read is the statement `reason-trailers.ts` ran through `executeRaw` (`src/core/engine-sql/sync-reason-reads.ts`). The purged change-reason pairs come from `readReasonPurgeTombstones` (see [sources.md](sources.md)). |
| `readReasonPurgeTombstones(sourceId, pair?)`, `readSourcePurgeEpoch(sourceId)` | the pairs `writeReasonPurgeTombstones` stored; the epoch `advanceSourcePurgeEpoch` left (0 before any purge), `null` for an unknown source | A purge's storage effects (the epoch bump, then its tombstones) advance the epoch, so a cached sync reason scan from before the purge is not reused (`sources.md`). On PGLite and Postgres the reads are the statements `reason-trailers.ts` `scanSyncReasons` and `cachedSyncReasonScan` ran through `executeRaw` (`src/core/engine-sql/sync-reason-reads.ts`). |
| `ownsSchemaTables()` | `true` | The process that opens the store owns all of it, so the schema owner of a schema-behind refusal is this caller (fix actor `agent`). |
| `readOAuthClientWriteGrant(clientId, opts?)` | `brain.readOauthClientWriteGrant`, `deleted_at` as a `Date`, or null | The client with this id, deleted or not ([oauth-clients.md](oauth-clients.md)), so `authorizeWrite` admits a write owned by a live client and refuses a deleted or absent one with the same `permission_denied` text as PGLite. `lock` changes nothing: one write transaction runs at a time. |
| `readAccessTokenWriteGrant(tokenId, opts?)` | `brain.readAccessTokenWriteGrant`, `revoked_at` as a `Date`, or null | The token with this id (a UUID, so any case; a non-UUID refuses as `id = $1` does), revoked or not ([access-tokens.md](access-tokens.md)); a live token is admitted and a revoked or absent one refused, as above. The private grants are not kept and read as `none`. |
| `shareLockWriteCredential(kind, id)` | no-op | The store runs one write transaction at a time, so no revocation lands between the re-check and the write. |
| `readOAuthClientWriteGrant(clientId, opts?)` | the grant columns, or `null` | Projected from the client's whole row (`readOauthClient`, [oauth-clients.md](oauth-clients.md)): `deleted_at`, `scope`, `source_id`, `source_grant`, `allowed_operations`, `bound_slug_prefixes`, `bound_tools`, `delegated_namespace`, `delegated_slug_prefixes`. A client the store does not have answers `null`, and `authorizeWrite` refuses `permission_denied`. `lock` holds nothing: one process owns the store. |
| `readAccessTokenWriteGrant(tokenId, opts?)` | the grant columns, or `null` | Read from the token's stored row ([access-tokens.md](access-tokens.md)): `id`, `scopes`, `permissions`, the five grant columns, `grant_revision`, `read_shared_revision` and `revoked_at`. `private_pages` and `private_facts` are not kept, so they are left out, as on a brain whose table lacks them; `authorizeWrite` does not read them. A token the store does not have answers `null`, and `authorizeWrite` refuses `permission_denied`. |
| `shareLockWriteCredential(kind, id)` | no-op | One process owns the store, so no other write can remove the credential between the lock and the read; a missing row locks nothing on Postgres either. |

`src/core/rust-engine/store-members/connect-gate.ts` answers the connect gate's persistence reads the same way
(SQL for PGLite and Postgres in `src/core/engine-sql/connect-gate.ts`):

| Member | Answer | Why |
| --- | --- | --- |
| `hasPersistenceTable(table)` | `true` | The store keeps the persistence state of one unmanaged brain, so every table a gate probes is there and empty. |
| `listManagedRootBindings(hostId, opts?)` | the roots of the worktrees this host binds (`listHostRootBindings`), then each source with a local path (archived ones too) with null `worktree_id` and `topology_generation`, without repeats | The two halves of PGLite's UNION; see "Worktree bindings" in [persistence.md](persistence.md). |
| `readGraduationGateRow(opts?)` | `null` | No graduation targets or leaves this engine, so there is no custody row and no run setting to compare. |
| `listRetiredDeactivations()` | `[]` | A brain here is never managed, so no writer deactivation committed. |

Caller-visible change (4e0f4976c4): before these members, the graduation connect gate (`readGraduationConnectRow`,
`assertGraduationConnectAllowed`) and the retired-marker cleanup (`cleanupRetiredManagedMarkers`) skipped their reads
on any engine that does not report the `raw_sql` capability (`lacksRawSql`), and read that as "no custody row" and
"nothing to clean up". The skips are gone. An engine that refuses `readGraduationGateRow` or `hasPersistenceTable`
with `engine_capability_missing` now refuses the connect, or the cleanup, with that refusal instead of carrying on as
if no row existed. Only a missing table (`42P01`, a brain before the migration) still reads as no row. The Rust
engine serves both members, so its connect is unchanged. An engine or test fake that does not report `raw_sql` and
does not serve these members now stops at connect. Refusing is the safer answer: a guessed "no row" could admit a
connect during a graduation.

`src/core/rust-engine/store-members/sync-status-reads.ts` answers the reads of `gbrain sync status` (SQL for PGLite
and Postgres in `src/core/engine-sql/sync-status-reads.ts`). The store keeps write request, effect, worktree,
source binding, worktree refresh and derived generation rows, but nothing on this engine yet writes the ones these reads
join. The engine holds `managed_persistence` back (`store-capabilities.ts` `HELD_FOR_CALLERS`), so a write to a
bound worktree refuses at admission and no refresh, request-recovery or derived-generation writer runs
(`gbrain sources refresh` refuses `raw_sql`). A remote write that queues a mention-links effect is admitted: the
links effect and a finished batch's re-arm are store members ([remote-links.md](remote-links.md)). Each part of a
join. The engine reports `managed_persistence`, so a write to a bound worktree is admitted and writes a request row,
but no refresh, request-recovery or derived-generation writer runs (`gbrain sources refresh` refuses `raw_sql`), and
these reads do not yet see a worktree-bound request (an open item below). A remote write that would queue a mention-links effect refuses
`raw_sql` at admission too (`requireRawSqlPublication`): the links effect and a finished batch's re-arm still read
through raw SQL. Each part of a
read that joins those rows still gives its empty answer below; a read that must see a worktree-bound request is an
open item of the capability flip, not served yet:

| Member | Answer | Why |
| --- | --- | --- |
| `readSyncStatusSourceRow(sourceId)` | the source's incarnation, last commit and sync time, whether the drain lock row exists, the pass and withheld-delete rows, and the admission setting; `null` for an archived or missing source | While the stored admission reads as normal the two probes are `null`. Otherwise `admission_pinned` is whether the pass row is `open`, carries the live drain lease's token and started before the dated `set_at`, and `admission_destructive` is `false` (no managed delete or keep_db reconcile is admitted: a managed sync stops on `raw_sql` at `assertManagedSyncAllowed`, worktree-refresh.ts). `writeback_failed` and `refresh` are `null`: no managed Git effect and no refresh row is written. |
| `readSyncStatusCommittedRow(sourceId)` | `{ n: 0, git_push_held: false, fence_held: false, last_committed_at: null }` | No managed-sync request commits (a managed sync stops on `raw_sql` before it admits one), and no fence generation is written. A Git effect of a worktree-bound page write is not read here yet: an open item of the capability flip. |
| `readManagedSyncCursorHeader`, `readRetiredManagedSyncCursor` | the `managed-sync` checkpoint rows, read as the SQL reads them | The store keeps op checkpoint rows. |
| `readManagedSyncFailureRows`, `readOrphanedManagedSyncFailureRows` | the unfinished cursors (or cursorless failures) of live source incarnations, with failure row and manifest path; `receipt` is `null` | No managed-sync request is admitted to give a receipt: a managed sync stops on `raw_sql` before it admits one. |
| `readSyncHeadRequestRow`, `readSyncRecoveryProbeRow` | `null`; `{ n: 0, request_id: null, slug: null, blocked: null }` | No request-recovery writer has landed. A worktree-bound page write now writes a request row, which this read does not see yet: an open item of the capability flip. |
| `readIdentityDowngradeRows(sourceIds)` | `[]`, or a refusal when a downgrade record exists | A record joins the pages it names, which this member does not serve. Records are written only through `executeRaw`, which this engine refuses, so none exists. |

The request members (`readWriteRequest`, `readWriteRequestById`, `listWriteRequestsByRequestIds`, `readWriteRequestProgress`, `countOutstandingBySource`, `readWorktreeAdmission`, `completeSyncedRefresh`, `hasDeferralRoom`, `readRefreshTiming`, `countHeldBehindImport`, `readCounterRows`, `readAdmissionRate`, `lockPersistenceCounters`,
`insertWriteRequest`, `stampWriteClaim`, `lockWriteRequest`, `completeWriteRow`, the grouped admission
`insertWriteRequestGroup` (one `brain.insertWriteRequestGroup` store write, in item order; a refusal keeps no row) and its
replay read `readWriteRequestsByRequestIds` (one `brain.readWriteRequest` per distinct id, letter case folded)), the claim upkeep
(`renewWriteClaim`, `releaseUnpublishedClaim`, `expireStaleWriteClaims`, `hasClaimableWrite`, the FIFO head read `selectClaimableWrite`) and the admission reads
(`readSourceMembership`, `findTopologyChanges`, `readLedgerSource`) are served from the persistence
rows in [persistence.md](persistence.md). The journal calls most of them inside `transaction`. The consumer row
members (`listHostConsumerRows`, `probeLiveConsumerRows`, `renewConsumerRow`, `deleteConsumerRow`) keep no
stored state; see "TypeScript members with no stored state" there. `stampWorktreeHeartbeats` stamps the
worktree rows of "Worktree bindings" there.
