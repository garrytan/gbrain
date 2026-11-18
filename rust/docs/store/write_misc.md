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
| `hasExtractedEvents(sourceId, pageId)` | `false` | The store keeps no chronicle extraction state. |
| `listActiveAccessMembers()` | `[]` | The store keeps no access members. |
| `isFolderRestricted(sourceId, slug)` | `false` | The store keeps no access state: no folder rules, no pending coverage, no row-level security. Every write of that state is raw SQL, which this engine refuses, so no slug is restricted. PGLite answers the same for a brain with no folder rules and no pending covers (`src/core/engine-sql/access-control.ts`). |
| `expireMemoryProposals(reason)`, `purgeMemoryProposals(days)` | `0` | The store keeps no memory proposals. |
| `listAwaitingMemoryProposals(limit)` | `[]` | The store keeps no memory proposals. |
