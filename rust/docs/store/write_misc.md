# The brain store: page-write reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are statements that a page write ran through `executeRaw` and that belong to no other storage domain
([docs/research/rust-put-write-path.md](../../../docs/research/rust-put-write-path.md)). PGLite and Postgres run the
same SQL as before, now in `src/core/engine-sql/write-misc.ts`. The store answers the source read
and the path attach from its source records (`crates/gbrain-store/src/write_misc.rs`) and has no keys of its own. The TypeScript
members (`src/core/rust-engine/store-members/write-misc.ts`) answer the others for state the store does not keep. The access member reads are in
[access-members.md](access-members.md).

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
| `listAccessTokens()` | every token row, newest first, with every column | The store keeps every column ([access-tokens.md](access-tokens.md)); the member is `store-members/access-serves.ts`. |
| `notifierCoverageRecorded()` | `false` | The store keeps no notifier state: a resident notifier refuses to start on a Rust brain, so no source has recorded coverage. Search carries the freshness notice only when `sync.on_commit` is on. |
| `readOpCheckpointKeys(op, fingerprint)` | the op's banked keys | Served by the store with the checkpoint writes (persistence.md, "Op checkpoints"); a resumable op stopped on this engine resumes with the keys it banked. |
| `readHealthMemoClock()` | `<brain id>/<commit sequence>` | The `readProjectionReadinessGeneration` value. Every commit advances it, a page write among them, so the get_health memo reuses an answer only while nothing was written. The SQL engines answer `<brain id>:<page clock>`; only equality between two reads of one engine matters. |
| `listSynopsisSourceIds()` | `[]` | The store keeps no source contextual-retrieval mode (only `sources` admin raw SQL writes it), so no source selects the synopsis tier. |
| `isFolderRestricted(sourceId, slug)` | `true` when a rule of the source covers the slug or a pending prefix of the source does | The store keeps the folder rules and pending prefixes ([access_rules.md](access_rules.md)); it has no row-level security, so the unreadable part is always false. |
| `listAppliedPolicyRevisions()` | `{ source_id, rev }` for each source with access state, by id; `rev` is the newest applied revision, `null` when none is applied | The store keeps the revision log ([access_rules.md](access_rules.md)). On PGLite and Postgres the read is the `access_policy_state` scan `access/caller.ts` `appliedAccessSummary` runs. |
| `readAccessStateUnreadable()` | `false` | The store keeps its access state in its own records, which always read; there is no row-level security. On PGLite and Postgres the read is the `gbrain_access_state_unreadable()` call `access/open-pages.ts` `withOpenScope` ran through `executeRaw` (`src/core/engine-sql/access-policy.ts`). |
| `countOpenPages(sources, exclude)` | `{ source, folder, type, visible, pages }` for each group of live pages of `sources` the empty-identity member-access policy admits, less each excluded prefix; `visible` is whether the page policy admits the page too; no set order | The open-page count of `gbrain access serves` and doctor `open_shared_pages`. The member reads `listLivePageSummaries` and `readCallerPageAccess` under each policy. It refuses before any read unless the rendered floor equals the no-caller member-access rendering, so the count is never wider. No page carries folder rule ids here (see `isFolderRestricted`). On PGLite and Postgres the read is the statement `access/open-pages.ts` `openPages` ran through `executeRaw` (`src/core/engine-sql/access-setup.ts`). |
| `readPageAdmitsCaller(sourceId, slug, identity)` | whether the member-access floor for `identity` admits the page row (live or soft-deleted), judged by the store for `identity`, with the satisfied folder rules `satisfiedFor(identity)` gives (the caller record's set only when `identity` is the record's own, none for any other identity), the record's folder coverage and its owner flag | `gbrain access who-can-read` asks it for each member ([access-members.md](access-members.md)). Served only for a restricted caller record whose rendering equals the reference; any other caller refuses with `engine_capability_missing`. See [page-visibility.md](page-visibility.md). |
| `readPageFolderRulesAdmit(sourceId, slug, satisfied)` | whether every rule that covers the page is in `satisfied` and no coverage of the caller's record covers it | Read from `listWhoCanReadPages` (`folder_rule_ids`) and the caller's folder coverage. |
| `countLineageClosingRules(ruleIds, sourceId)` | the ids that do not name an applied raw-only rule of the source | Read from the store's rules (`listAccessRules`, `covers_derived`), so an id no rule answers counts, as on PGLite. |
| `readFolderAccess(readers)` | `{ rules, coverage }`: the rules whose `readable_by` names any reader, and the pending prefixes | The store keeps the folder rules and pending prefixes ([access_rules.md](access_rules.md)); no `'!unreadable'` row, as it has no row-level security. |
| `expireMemoryProposals(reason)`, `purgeMemoryProposals(days)` | `0` | The store keeps no memory proposals. |
| `listAwaitingMemoryProposals(limit)` | `[]` | The store keeps no memory proposals. |
| `readPendingProposalSummary()` | `{ n: 0, oldest: null }` | The store keeps no memory proposals, so `gbrain status` and `gbrain doctor` report none pending. |
| `listMemoryProposalRows(query)` | `[]` | The store keeps no memory proposals, so `gbrain memory-proposals list` lists none, on every page. |
| `listOwnerProposalRows(requestId)` | `[]` | No request id names a proposal, so `gbrain memory-proposals show`, `approve` and `deny` answer `not_found`. |
| `readMemoryProposal(principalKind, principalId, requestId)` | `null` | The store keeps no memory proposals, so `get_write_request` and `cancel_write_request` answer `not_found` for a request id with no write request. |
