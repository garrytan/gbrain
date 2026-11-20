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
| `readJournalLimitRows()` | the config keys that start with `persistence.limits.`, the page-body keys, then `{ key: null, value: null }` | The store keeps no segmented pages, so the largest one has no size. |
| `readHeldPageRows(pageIds)`, `readHeldCoverageRows(sourceIds)` | `[]` | The store holds no files from a sync, so nothing is held. |
| `listFenceHoldRows(sourceIds, kinds, ownerKey?)` (`src/core/rust-engine/store-members/fence-holds.ts`) | `[]` | Only a facts or takes fence publish holds a fence result, and it writes `derived_generations` through `executeRaw`, which this engine refuses. A family that lets the store publish fence generations must read its held rows here. |
| `ownsSchemaTables()` | `true` | The process that opens the store owns all of it, so the schema owner of a schema-behind refusal is this caller (fix actor `agent`). |
| `readOAuthClientWriteGrant(clientId, opts?)` | `null` | The store keeps no OAuth clients (its writers are `local_cli` and `local_stdio`), so a write owned by one finds no live grant and `authorizeWrite` refuses `permission_denied`, as a Postgres or PGLite brain without that client does. |
| `readAccessTokenWriteGrant(tokenId, opts?)` | `null` | The store keeps no legacy access tokens; same answer and refusal as above. |
| `shareLockWriteCredential(kind, id)` | no-op | No credential row exists to hold; a missing row locks nothing on Postgres either. |

`src/core/rust-engine/store-members/connect-gate.ts` answers the connect gate's persistence reads the same way
(SQL for PGLite and Postgres in `src/core/engine-sql/connect-gate.ts`):

| Member | Answer | Why |
| --- | --- | --- |
| `hasPersistenceTable(table)` | `true` | The store keeps the persistence state of one unmanaged brain, so every table a gate probes is there and empty. |
| `listManagedRootBindings(hostId, opts?)` | each source with a local path (archived ones too), with null `worktree_id` and `topology_generation` | No host binds a managed worktree; the source rows are the second half of PGLite's UNION. |
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

The request members (`readWriteRequest`, `readWriteRequestById`, `readWriteRequestProgress`, `countOutstandingBySource`, `readCounterRows`, `readAdmissionRate`, `lockPersistenceCounters`,
`insertWriteRequest`, `stampWriteClaim`, `lockWriteRequest`, `completeWriteRow`), the claim upkeep
(`renewWriteClaim`, `releaseUnpublishedClaim`, `expireStaleWriteClaims`, `hasClaimableWrite`, the FIFO head read `selectClaimableWrite`) and the admission reads
(`readSourceMembership`, `findTopologyChanges`, `readLedgerSource`) are served from the persistence
rows in [persistence.md](persistence.md). The journal calls most of them inside `transaction`. The consumer row
members (`listHostConsumerRows`, `probeLiveConsumerRows`, `renewConsumerRow`, `deleteConsumerRow`,
`stampWorktreeHeartbeats`) keep no stored state; see "TypeScript members with no stored state" there.
