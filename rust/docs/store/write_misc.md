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
| `listAccessTokens()` | `[]` | The store keeps no access tokens: minting, revoking and the bearer check are raw SQL on `access_tokens`, which this engine refuses, so `gbrain auth list` lists none. PGLite answers the same for a brain with no tokens. |
| `notifierCoverageRecorded()` | `false` | The store keeps no notifier state: a resident notifier refuses to start on a Rust brain, so no source has recorded coverage. Search carries the freshness notice only when `sync.on_commit` is on. |
| `readOpCheckpointKeys(op, fingerprint)` | the op's banked keys | Served by the store with the checkpoint writes (persistence.md, "Op checkpoints"); a resumable op stopped on this engine resumes with the keys it banked. |
| `readHealthMemoClock()` | `<brain id>/<commit sequence>` | The `readProjectionReadinessGeneration` value. Every commit advances it, a page write among them, so the get_health memo reuses an answer only while nothing was written. The SQL engines answer `<brain id>:<page clock>`; only equality between two reads of one engine matters. |
| `listSynopsisSourceIds()` | `[]` | The store keeps no source contextual-retrieval mode (only `sources` admin raw SQL writes it), so no source selects the synopsis tier. |
| `isFolderRestricted(sourceId, slug)` | `false` | The store keeps no access state: no folder rules, no pending coverage, no row-level security. Every write of that state is raw SQL, which this engine refuses, so no slug is restricted. PGLite answers the same for a brain with no folder rules and no pending covers (`src/core/engine-sql/access-control.ts`). |
| `listAppliedPolicyRevisions()` | `[]` | No source holds folder access state (see `isFolderRestricted`), so no source has an applied revision. On PGLite and Postgres the read is the `access_policy_state` scan that `access/caller.ts` `appliedAccessSummary` ran through `executeRaw` (`src/core/engine-sql/access-control.ts`). |
| `readMayActFor(via, key)` | the config value for `stdio_config`, `null` otherwise | A stdio server's may_act_for is a config value, which the store keeps (`getConfig`). The store keeps no access tokens and no OAuth clients, so a token or a client has no live row and permits nothing, as a revoked token or a deleted client does. On PGLite and Postgres the read is the statement `access/caller.ts` `mayActForOf` ran through `executeRaw` (`src/core/engine-sql/access-control.ts` `MAY_ACT_FOR_SQL`). |
| `readAudiencePrincipals(memberIds, groupIds)` | `{ members: [], groups: [] }` | The store keeps no access members and no groups (see `listActiveAccessMembers`), so an audience entry names no enabled member and no existing group: each reads as unknown, as on a brain with none. On PGLite and Postgres the reads are the two statements `access/caller.ts` `resolveAudienceIdentities` ran through `executeRaw` (`AUDIENCE_MEMBERS_SQL`, `AUDIENCE_GROUPS_SQL`). |
| `readAccessMembers(by)` | `[]` | The store keeps no access members (see `listActiveAccessMembers`), so no id or email names a member and the list is empty, as on a brain with none. On PGLite and Postgres the reads are the statements `access/members.ts` `getMember`, `memberByEmail`, `assertEmailFree` and `listMembers` ran through `executeRaw` (`ACCESS_MEMBER_SQL`); the list filters out removed members in the statement unless `includeRemoved`. |
| `readAccessCredentials(by)` | `[]` | The store keeps no access tokens and no OAuth clients (see `readMayActFor`), so no token name and no member binding names a live credential, as on a brain with none. On PGLite and Postgres the reads are the statements `access/members.ts` `legacyTokenByName` and `boundCredentials` (tokens, then clients) ran through `executeRaw` (`ACCESS_CREDENTIAL_SQL`); revoked tokens and deleted clients are filtered out in the statement. |
| `listAudienceAccessMembers()` | `[]` | The store keeps no access members (see `listActiveAccessMembers`), so no member is of kind audience, as on a brain with none. On PGLite and Postgres the read is the statement `access/members.ts` `audienceMemberIds` ran through `executeRaw` (`AUDIENCE_KIND_MEMBERS_SQL`); a person, a disabled member and a removed member are filtered out in the statement. |
| `readLiveMember(via, key)` | `null` | The store keeps no access members (see `listActiveAccessMembers`), so no member id, stdio config key, token or client names a live member, and `access/caller.ts` `memberIdentityFor` and `stdioMemberIdentity` find the empty identity, as for an unbound caller. On PGLite and Postgres the read is the statement `liveIdentity` ran through `executeRaw` (`LIVE_MEMBER_SQL`, one per route); a disabled member, a removed member, a revoked token and a deleted client are filtered out in the statement, and a member carries only its own groups. |
| `readFolderAccess(readers)` | `{ rules: [], coverage: [] }` | No folder rule or folder coverage exists on this engine (see `isFolderRestricted`), so no rule is satisfied and no prefix reads as nobody; a seed of `access_rules` or `access_pending_coverage` refuses as raw SQL. On PGLite and Postgres the reads are the two statements `access/caller.ts` `folderAccessForAll` ran through `executeRaw` (`src/core/engine-sql/access-control.ts`), still through the engine's own `executeRaw`. |
| `expireMemoryProposals(reason)`, `purgeMemoryProposals(days)` | `0` | The store keeps no memory proposals. |
| `listAwaitingMemoryProposals(limit)` | `[]` | The store keeps no memory proposals. |
| `readPendingProposalSummary()` | `{ n: 0, oldest: null }` | The store keeps no memory proposals, so `gbrain status` and `gbrain doctor` report none pending. |
| `listMemoryProposalRows(query)` | `[]` | The store keeps no memory proposals, so `gbrain memory-proposals list` lists none, on every page. |
| `listOwnerProposalRows(requestId)` | `[]` | No request id names a proposal, so `gbrain memory-proposals show`, `approve` and `deny` answer `not_found`. |
| `readMemoryProposal(principalKind, principalId, requestId)` | `null` | The store keeps no memory proposals, so `get_write_request` and `cancel_write_request` answer `not_found` for a request id with no write request. |
