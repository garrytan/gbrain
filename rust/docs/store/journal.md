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

Four persistence members are served on a Rust brain: `readManagedModeRows()` and `ownsSchemaTables()`
(`src/core/rust-engine/store-members/persistence.ts:14-18`), `readPersistenceBrainId()`
(`store-members/persistence-identity.ts:7`) and `readWriterAdminState` (`store-members/writer-admin.ts`, see
[persistence.md](persistence.md)). No other module in `store-members/` exports a persistence member. Every other
member below is classified `persistence_journal` (or the family named in the table) in
`src/core/rust-engine/members/persistence.ts` and `members.ts`, so a call rejects with `engine_capability_missing`
before any work, and `servedCapabilities()` (`store-capabilities.ts`) does not report `persistence_journal`. The
native store methods in the table exist; no TypeScript member calls them.

| Member | On a Rust brain | Native store method |
| --- | --- | --- |
| `readManagedModeRows()` | served: `[{ enabled }]`, the stored brain mode (`writerReleaseRows({ kind: 'brain_mode' })`, `store-members/persistence.ts:9-15`). The mode is `false` until `setBrainEnabled(true)` records an activation, so a new brain reads unmanaged; the answer is the stored flag, not a constant | `brain_mode_in`, `set_brain_enabled_in` (`persistence/worktrees/release.rs:61,68`) |
| `ownsSchemaTables()` | served: `true`, because the process that opens the store owns all of it | none |
| `readLocalWriterRow(id, opts?)`, `insertLocalWriterRow(row)` | refuse (`members.ts:318-319`) | `brain.readLocalWriter`, `brain.insertLocalWriterRow` (`gbrain-store/src/journal.rs:953,912`) |
| `revokeLocalWriterRow(id)` | not a BrainEngine member on this tree; only `src/core/engine-sql/persistence-state.ts` names it | `brain.revokeLocalWriter` (`journal.rs:965`) |
| `readJournalLimitRows()` | refuses (`members/persistence.ts:14`) | none by that name |
| `readHeldPageRows`, `readHeldCoverageRows`, `readGitHoldRecords` | not BrainEngine members on this tree; they appear only as names in the typed-read lists of `src/core/statement-deadline.ts:108-119` and `src/core/persistence/bounded-reads.ts:102`. The git hold read is `readGitSourceHolds` (`src/core/persistence/sync-holds.ts:579`), which takes the engine as its executor | none |
| `listFenceHoldRows`, `clearFenceHoldRows` | no TypeScript member and no `store-members/fence-holds.ts` | `brain.listFenceHoldRows`, `brain.clearFenceHoldRows` (`gbrain-store/src/generations.rs:826,896`; [generations.md](generations.md)) |
| `readFenceOriginGone`, `lockGenerationKey`, `readFenceHoldFiles` | no TypeScript file names them | `lockGenerationKey` is named only in `gbrain-store/src/generations/activations.rs`; the other two have no store method |
| `readSourcePurgeEpoch(sourceId)` | refuses: classified `pages` with the comment "held: no Rust store member yet" (`members/persistence.ts:15`) | `brain.readSourcePurgeEpoch` (`gbrain-store/src/sources.rs:409`; [sources.md](sources.md)). On PGLite and Postgres the read is the statement in `src/core/engine-sql/sync-reason-reads.ts` |
| `readReasonPurgeTombstones(sourceId, pair?)` | not a BrainEngine member on this tree | `brain.readReasonPurgeTombstones`, `writeReasonPurgeTombstones` (`gbrain-store/src/reason_tombstones.rs:90`; [sources.md](sources.md)) |
| `readOAuthClientWriteGrant(clientId, opts?)`, `readAccessTokenWriteGrant(tokenId, opts?)` | refuse (`members/persistence.ts:21-22`) | `brain.readOauthClientWriteGrant`, `brain.readAccessTokenWriteGrant` (`gbrain-store/src/jobs/credential_binding.rs:250,264`; [oauth-clients.md](oauth-clients.md), [access-tokens.md](access-tokens.md)) |
| `shareLockWriteCredential(kind, id)` | refuses (`members/persistence.ts:23`) | none |

## The connect gate

No file `store-members/connect-gate.ts` exists. `hasPersistenceTable(table)` and `listManagedRootBindings(hostId, opts?)`
are classified `persistence_journal` and refuse on a Rust brain (`members/persistence.ts:16-17`); their SQL for PGLite and
Postgres is `src/core/engine-sql/connect-gate.ts`. The native `listHostRootBindings` (`gbrain-store/src/persistence/worktrees.rs:922`)
is the worktree half of the root-bindings read; no TypeScript member calls it. `readGraduationGateRow` is a function in
`engine-sql/connect-gate.ts` that takes an executor, not a BrainEngine member, and no store method of that name exists.
`listRetiredDeactivations` is not a BrainEngine member; the store answers it as the `retired_deactivations` kind of the writer release rows (`gbrain-store/src/persistence/worktrees/release.rs:374`, `committed_outcomes_in` at `persistence/topology.rs:443`; [persistence.md](persistence.md)).

The graduation connect gate and the retired-marker cleanup still skip their reads on an engine that does not report `raw_sql`
(`lacksRawSql`, `src/core/engine-capabilities.ts:141`): `src/core/persistence/graduation-schema.ts:131` returns `null` and
`src/core/persistence/deactivation.ts:361` returns its empty report. A Rust brain does not report `raw_sql`, so it takes those
skips.

## Sync status reads

No file `store-members/sync-status-reads.ts` or `src/core/engine-sql/sync-status-reads.ts` exists, and no TypeScript or Rust
file names `readSyncStatusSourceRow`, `readSyncStatusCommittedRow`, `readSyncHeadRequestRow`, `readSyncRecoveryProbeRow` or
`readIdentityDowngradeRows`. The engine does not report `managed_persistence` (`readOwnerHostBinding` is classified with it,
`members/persistence.ts:28`) and does not report `persistence_journal`; nothing in `store-capabilities.ts` holds a capability
back by name.

## Request, claim and consumer members

The write request members (`readWriteRequest`, `readWriteRequestById`, `readWriteRequestsByRequestIds`, `readCounterRows`,
`readAdmissionRate`, `lockPersistenceCounters`, `insertWriteRequest`, `stampWriteClaim`, `lockWriteRequest`, `completeWriteRow`,
`renewWriteClaim`, `releaseUnpublishedClaim`, `readSourceMembership`, `findTopologyChanges`, `readLedgerSource`) are classified
`persistence_journal` and refuse on a Rust brain; none is exported from `store-members/`. The native methods behind most of them
are in `gbrain-napi/src/families/journal.rs` (`read_write_request`, `list_write_requests_by_request_ids`, `insert_write_request`,
`insert_write_request_group`, `stamp_write_claim`, `renew_write_claim`, `expire_stale_write_claims`, `has_claimable_write`,
`select_claimable_write`, `count_outstanding_by_source`, `read_worktree_admission`, `complete_synced_refresh`,
`has_deferral_room`, `read_refresh_timing`, `count_held_behind_import`, `read_source_membership`, `find_topology_changes`)
and `worktrees.rs` (`stamp_worktree_heartbeats`). `readWriteRequestProgress`, `lockWriteRequest` and the consumer row members
(`listHostConsumerRows`, `probeLiveConsumerRows`, `renewConsumerRow`, `deleteConsumerRow`) have no native method of that name;
the consumer members are named only in `src/core/statement-deadline.ts`.
