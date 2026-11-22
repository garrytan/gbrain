# The brain store: page-write reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are statements that a page write ran through `executeRaw` and that belong to no other storage domain
([docs/research/rust-put-write-path.md](../../../docs/research/rust-put-write-path.md)). PGLite and Postgres run the
same SQL as before, now in `src/core/engine-sql/write-misc.ts`. The store answers the source read
and the path attach from its source records (`crates/gbrain-store/src/write_misc.rs`) and has no keys of its own. The folder
access reads go to the `access_rules` family ([access_rules.md](access_rules.md)). The TypeScript members
(`src/core/rust-engine/store-members/write-misc.ts`) answer the others for state the store does not keep.

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
| `getWorktreeBinding(sourceId, hostId)` | `brain.getWorktreeBinding` | The binding an unmanaged writer claim (`claimWorktree`) recorded; `null` for an unbound source. See "Worktree bindings" in [persistence.md](persistence.md). |
| `isSourceClaimed(sourceId)` | `brain.isSourceClaimed` | Whether a binding names the source at its current incarnation, as the `EXISTS` over `persistence_source_bindings` in `engine-sql/sources.ts` reads it. A claimed source meets classic sync's pre-activation claim refusal here too. |
| `hasExtractedEvents(sourceId, pageId)` | `false` | The store keeps no chronicle extraction state. |
| `listActiveAccessMembers()` | `[]` | The store keeps no access members. |
| `hasLabelledOnlyMember()` | `false` | The store keeps no access members, so none carries the labelled-only grant and a remote write skips the labelled-only checks. |
| `listAccessTokens()` | `[]` | The store keeps no access tokens: minting, revoking and the bearer check are raw SQL on `access_tokens`, which this engine refuses, so `gbrain auth list` lists none. PGLite answers the same for a brain with no tokens. |
| `readOpCheckpointKeys(op, fingerprint)` | the op's banked keys | Served by the store with the checkpoint writes (persistence.md, "Op checkpoints"); a resumable op stopped on this engine resumes with the keys it banked. |
| `readHealthMemoClock()` | `<brain id>/<commit sequence>` | `brain.readHealthMemoClock()`: the `readProjectionReadinessGeneration` value outside a transaction. Every commit advances it, a page write among them, so the get_health memo reuses an answer only while nothing was written. The SQL engines answer `<brain id>:<page clock>`; only equality between two reads of one engine matters. |
| `listSynopsisSourceIds()` | the `sourceIds` of `readSynopsisTierSources({ skipFrontmatter: true })` | The sources that are not archived and whose own mode is per_chunk_synopsis, by id in byte order (source-cr-mode.md). |
| `isFolderRestricted(sourceId, slug)` | `brain.isFolderRestricted` | Folder rules and pending prefixes are store records ([access_rules.md](access_rules.md)). The store has no row-level security, so the unreadable part is always false. |
| `listAppliedPolicyRevisions()` | `brain.listAppliedPolicyRevisions` | Each source with policy state and its newest applied revision ([access_rules.md](access_rules.md)). On PGLite and Postgres the read is the `access_policy_state` scan that `access/caller.ts` `appliedAccessSummary` ran through `executeRaw` (`src/core/engine-sql/access-control.ts`). |
| `readFolderAccess(readers)` | `brain.readFolderAccess` | The folder rules whose readers name any of `readers` and every pending prefix ([access_rules.md](access_rules.md)); no `'!unreadable'` row, since the store has no row-level security. On PGLite and Postgres the reads are the two statements `access/caller.ts` `folderAccessForAll` ran through `executeRaw` (`FOLDER_RULES_FOR_READERS_SQL`, `FOLDER_COVERAGE_SQL`). |
| `readMayActFor(via, key)` | the config value for `stdio_config`, `null` otherwise | A stdio server's may_act_for is a config value, which the store keeps (`getConfig`). The store keeps no access tokens and no OAuth clients, so a token or a client has no live row and permits nothing, as a revoked token or a deleted client does. On PGLite and Postgres the read is the statement `access/caller.ts` `mayActForOf` ran through `executeRaw` (`src/core/engine-sql/access-control.ts` `MAY_ACT_FOR_SQL`). |
| `readJobPrincipal(principal)` | `null` | The store keeps no access tokens and no OAuth clients, so a queued remote job's principal has no row and `minions/submission-authority.ts` `assertCurrentRemoteJobPrincipal` denies the job as missing or revoked. On PGLite and Postgres the read is the statement that check ran through `executeRaw` for the principal's kind (`src/core/engine-sql/access-control.ts` `JOB_PRINCIPAL_SQL`), revoked and deleted rows included. |
| `readAudiencePrincipals(memberIds, groupIds)` | `{ members: [], groups: [] }` | The store keeps no access members and no groups (see `listActiveAccessMembers`), so an audience entry names no enabled member and no existing group: each reads as unknown, as on a brain with none. On PGLite and Postgres the reads are the two statements `access/caller.ts` `resolveAudienceIdentities` ran through `executeRaw` (`AUDIENCE_MEMBERS_SQL`, `AUDIENCE_GROUPS_SQL`). |
| `readAccessMembers(by)` | `[]` | The store keeps no access members (see `listActiveAccessMembers`), so no id or email names a member and the list is empty, as on a brain with none. On PGLite and Postgres the reads are the statements `access/members.ts` `getMember`, `memberByEmail`, `assertEmailFree` and `listMembers` ran through `executeRaw` (`ACCESS_MEMBER_SQL`); the list filters out removed members in the statement unless `includeRemoved`. |
| `readAccessCredentials(by)` | `[]` | The store keeps no access tokens and no OAuth clients (see `readMayActFor`), so no token name and no member binding names a live credential, as on a brain with none. On PGLite and Postgres the reads are the statements `access/members.ts` `legacyTokenByName` and `boundCredentials` (tokens, then clients) ran through `executeRaw` (`ACCESS_CREDENTIAL_SQL`); revoked tokens and deleted clients are filtered out in the statement. |
| `listAudienceAccessMembers()` | `[]` | The store keeps no access members (see `listActiveAccessMembers`), so no member is of kind audience, as on a brain with none. On PGLite and Postgres the read is the statement `access/members.ts` `audienceMemberIds` ran through `executeRaw` (`AUDIENCE_KIND_MEMBERS_SQL`); a person, a disabled member and a removed member are filtered out in the statement. |
| `readLiveMember(via, key)` | `null` | The store keeps no access members (see `listActiveAccessMembers`), so no member id, stdio config key, token or client names a live member, and `access/caller.ts` `memberIdentityFor` and `stdioMemberIdentity` find the empty identity, as for an unbound caller. On PGLite and Postgres the read is the statement `liveIdentity` ran through `executeRaw` (`LIVE_MEMBER_SQL`, one per route); a disabled member, a removed member, a revoked token and a deleted client are filtered out in the statement, and a member carries only its own groups. |
| `expireMemoryProposals(reason)`, `purgeMemoryProposals(days)` | `0` | The store keeps no memory proposals. |
| `listAwaitingMemoryProposals(limit)` | `[]` | The store keeps no memory proposals. |
| `readPendingProposalSummary()` | `{ n: 0, oldest: null }` | The store keeps no memory proposals, so `gbrain status` and `gbrain doctor` report none pending. |
| `listMemoryProposalRows(query)` | `[]` | The store keeps no memory proposals, so `gbrain memory-proposals list` lists none, on every page. |
| `listOwnerProposalRows(requestId)` | `[]` | No request id names a proposal, so `gbrain memory-proposals show`, `approve` and `deny` answer `not_found`. |
| `readMemoryProposal(principalKind, principalId, requestId)` | `null` | The store keeps no memory proposals, so `get_write_request` and `cancel_write_request` answer `not_found` for a request id with no write request. |
