# The brain store: page-write reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are statements that a page write ran through `executeRaw` and that belong to no other storage domain
([docs/research/rust-put-write-path.md](../../../docs/research/rust-put-write-path.md)). PGLite and Postgres run the
same SQL as before, now in `src/core/engine-sql/write-misc.ts`. The store answers the source read
and the path attach from its source records (`crates/gbrain-store/src/write_misc.rs`) and has no keys of its own. The TypeScript
members (`src/core/rust-engine/store-members/write-misc.ts`) answer the others for state the store does not keep.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readSourceState(sourceId)` | `{ incarnation, archived, local_path, config }`, or `null` for an unknown id | `readSourceState` |
| `brain.attachSourcePath(sourceId, localPath, name, federated)` | `true` after it sets `local_path`, replaces the name when `name` is not `null` and sets `config.federated` when `federated` is not `null`; `false`, with no change, for an unknown id | `attachSourcePath` |

The link endpoint read (`listLinkEndpointPages`) is in [link_queries.md](link_queries.md).

## TypeScript members

| Member | Answer on this engine | Why |
| --- | --- | --- |
| `readSourceState(sourceId, { lock: 'share' })` | `brain.readSourceState`; the lock is dropped | The store runs one write transaction at a time, so a read never overlaps a source change. |
| `attachSourcePath(sourceId, localPath, opts)` | `brain.attachSourcePath`; resolves nothing | The SQL engines return no rows either. |
| `readAdmissionSource(sourceId)` | `brain.readSourceState` with `kind` and `role` as `config->>'kind'` and `config->>'role'` read them (text as is, `null` when missing, JSON text otherwise); `guest_writers` and `guest_trust_ceiling` `null`; `guest_sources_hidden` `false` | The store has no `guest_sources` table and no row-level security; a guest source is one whose config says guest (see [cli-reads-import.md](cli-reads-import.md)). |
| `sharedSkillPackTablePresent()` | `true` | The answer of a current schema: the store is never on a schema from before shared skills. It keeps no pack, so `listSharedSkillPackRoots` returns `[]`. |
| `listSharedSkillPackRoots(hostId)` | `[]` | No shared skillpacks exist. |
| `getWorktreeBinding(sourceId, hostId)` | `null` | The store keeps no writer bindings. A brain on this engine is never managed (`readManagedModeRows`), and the binding writers (`claimWorktree`) run raw SQL, which this engine refuses, so no source is bound on any host. PGLite answers the same for a source with no binding. |
| `isSourceClaimed(sourceId)` | `false` | No source is bound on this engine (see `getWorktreeBinding`), so no binding claims a source and classic sync never meets the pre-activation claim refusal. On PGLite and Postgres the read is the `EXISTS` over `persistence_source_bindings` that `sync-authority.ts` ran through `executeRaw` (`engine-sql/sources.ts`). |
| `hasExtractedEvents(sourceId, pageId)` | `false` | The store keeps no chronicle extraction state. |
| `listActiveAccessMembers()` | `[]` | The store keeps no access members. |
| `hasLabelledOnlyMember()` | `false` | The store keeps no access members, so none carries the labelled-only grant and a remote write skips the labelled-only checks. |
| `isFolderRestricted(sourceId, slug)` | `false` | The store keeps no access state: no folder rules, no pending coverage, no row-level security. Every write of that state is raw SQL, which this engine refuses, so no slug is restricted. PGLite answers the same for a brain with no folder rules and no pending covers (`src/core/engine-sql/access-control.ts`). |
| `listAppliedPolicyRevisions()` | `[]` | No source holds folder access state (see `isFolderRestricted`), so no source has an applied revision. On PGLite and Postgres the read is the `access_policy_state` scan that `access/caller.ts` `appliedAccessSummary` ran through `executeRaw` (`src/core/engine-sql/access-control.ts`). |
| `readLiveMember(via, key)` | `null` | The store keeps no access members (see `listActiveAccessMembers`), so no key names a live member through any binding; `access/caller.ts` reads that as unbound and a writer reads as nobody, as PGLite does for a brain with no members; a stdio binding stored in config resolves no member either. On PGLite and Postgres the read is the member lookup `access/caller.ts` `liveIdentity` ran through `executeRaw` (`src/core/engine-sql/access-control.ts`), still through the engine's own `executeRaw`. |
| `readFolderAccess(readers)` | `{ rules: [], coverage: [] }` | No folder rule or folder coverage exists on this engine (see `isFolderRestricted`), so no rule is satisfied and no prefix reads as nobody; a seed of `access_rules` or `access_pending_coverage` refuses as raw SQL. On PGLite and Postgres the reads are the two statements `access/caller.ts` `folderAccessForAll` ran through `executeRaw` (`src/core/engine-sql/access-control.ts`), still through the engine's own `executeRaw`. |
| `expireMemoryProposals(reason)`, `purgeMemoryProposals(days)` | `0` | The store keeps no memory proposals. |
| `listAwaitingMemoryProposals(limit)` | `[]` | The store keeps no memory proposals. |
| `readMemoryProposal(principalKind, principalId, requestId)` | `null` | The store keeps no memory proposals, so `get_write_request` and `cancel_write_request` answer `not_found` for a request id with no write request. |
