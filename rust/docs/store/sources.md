# The brain store: Sources

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A fresh brain has the `default` source: `{ id: 'default', name: 'default', local_path: null,
last_sync_at: null, config: { federated: true } }`. A row is PGLite's `SourceRow` plus
`incarnation` (a UUID that changes when a source is deleted and created again), with
`last_sync_at` as an ISO string. The record also keeps the source's `chunker_version` stamp, absent
until the first stamp; the import members read and write it ([import-members.md](import-members.md)).
It keeps the sync anchor too: `last_commit` and `newest_content_at`, absent until the first sync
advances them. Records written before these fields existed read them as absent.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listAllSources({ includeArchived?, localPathOnly? }?)` | `SourceRow[]`, `default` first then by `id` in byte order (the SQL engines sort `id COLLATE "C"`); archived rows are left out unless `includeArchived`; `localPathOnly` keeps rows with a `local_path` that are not `config.role = 'storage_manifest'` | `listAllSources` |
| `brain.getSourceById(id)` | `SourceRow \| null`, archived rows included | `sources-ops` read by id |
| `brain.upsertSource({ id, name?, local_path?, last_sync_at?, config? })` | the `SourceRow`; only the fields given change; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `sources add` |
| `brain.updateSourceConfig(id, patch)` | `boolean`, whether the source exists; `patch` is merged one level deep, and a `null` value is kept as JSON `null` (it does not remove the key) | `updateSourceConfig` |
| `brain.markSourceSynced(id, { incarnation?, newestContentAt? }?)` | `boolean`, whether a source was stamped; sets `last_sync_at` to the store clock at the moment of the write (`now()` on the SQL engines), and an unknown id changes nothing. With `incarnation` (a managed sync run's guard) only a source still of that incarnation is stamped, compared without case; a malformed id is refused with `invalid_argument`, as the SQL `::uuid` cast refuses it. `newestContentAt` (timestamptz text: ISO with `Z` or an offset) also sets `newest_content_at`; null or absent keeps it, as `COALESCE` does; text that is not a time is refused | `markSourceSynced` |
| `brain.setSourceArchived(id, archived)` | `boolean`, whether the source exists | `sources archive` and `restore` |
| `brain.insertSource(id, name, localPath, config)` | the new `SourceRow`; a taken `id` or `name` refuses `constraint_violation` and writes nothing; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `insertSource` (`sources add`) |
| `brain.advanceSourceCommit(id, commit, setNewest, newestContentAt)` | nothing; one write that sets `last_commit` and `last_sync_at` (the process clock), and `newest_content_at` when `setNewest` is true (`null` clears it); archived sources advance too, and an unknown source changes nothing | `advanceSourceCommit` (the sync anchor) |
| `brain.readSourceLastCommit(id)` | the source's `last_commit`, archived sources included, or `null` before a sync and for a missing source | `readSourceLastCommit` (the resident notifier's `lastCommit`) |
| `brain.countRepoBoundSources()` | `number`, the sources that are not archived and have a non-empty `local_path` | `countRepoBoundSources` (the readiness sync probe) |
| `brain.listSourcePathPages(sourceId)` | `{ slug, source_path }[]`, the source's live pages that record a source path, in slug byte order | `listSourcePathPages` (the full sync's stale-page reconcile) |
| `brain.readRenameIdentityRows(sourceId, paths, slugs)` | `{ slug, source_path, title }[]`, the source's live pages whose source path is in `paths` or slug in `slugs`, in slug byte order | `readRenameIdentityRows` (a sync's rename confirmation) |
| `brain.readLiveIdentityHolders(sourceId, ids, titles)` | `{ slug, source_path, fm_id, title }[]`, the source's live pages whose frontmatter `id` (a string as is, any other value as its JSON text) is in `ids` or title in `titles`, in slug byte order | `readLiveIdentityHolders` (a sync's rename confirmation) |
| `brain.readPageIdentity(pageId)` | `{ fm_id, title }` of a live page, or `null` | `readPageIdentity` (a held rename decided again) |
| `brain.holdPageEmbedding(pageId, reason)` | `null`; sets the page's `page_embedding_budget` ledger row to `{ state: 'held', reason }`: adds the row when the page has none, re-holds an open row and replaces a held row's reason, and keeps the row's spend columns (signature, spent, reserved, window, unpriced calls, cap); an unknown page id refuses `page_not_found`; a reason with a NUL byte refuses `invalid_argument`; a hard page delete drops the row | `holdPageEmbedding` (page-embedding-budget.ts) |
| `brain.readReasonPurgeTombstones(sourceId, pair)` | `{ commit_sha, path }[]`, the source's purged change-reason pairs by commit then path, or only `pair` (when not `null`) if it is stored | `readReasonPurgeTombstones` (`reason_purge_tombstones`) |
| `brain.writeReasonPurgeTombstones(sourceId, pairs)` | `number`, the pairs added; a stored or repeated pair adds nothing; an unknown source refuses `source_not_found` and stores nothing; a source delete drops its pairs | `writeReasonPurgeTombstones` (facts purge) |
| `brain.advanceSourcePurgeEpoch(sourceId)`, `brain.readSourcePurgeEpoch(sourceId)` | `number`, the source's purge epoch after adding one / as stored (0 before any purge); `null` for an unknown source, which changes nothing | `advanceSourcePurgeEpoch` (`belief/purge.ts` `bumpPurgeEpoch`), `readSourcePurgeEpoch` (`reason-trailers.ts` `cachedSyncReasonScan`, `readLedgerSource`) |
| `brain.countSourcePages(sourceId, includeDeleted)` | `number`, the source's pages; soft-deleted pages count only with `includeDeleted`; an unknown source has none | `countSourcePages` (`sources list`, `status`, `remove`) |
| `brain.advanceSourceCommit(sourceId, commit, setNewest, newestContentAt)` | `undefined`; sets `last_commit` and stamps `last_sync_at` now; with `setNewest` also sets `newest_content_at` (an ISO time, or `null` to clear it); an unknown source changes nothing | `advanceSourceCommit` (`writeSyncAnchor` of `src/core/sync-anchor.ts`) |
| `brain.writeSourceSyncHeartbeat(sourceId)` | `undefined`; sets `last_sync_at` to the store clock and leaves `last_commit` alone; an unknown source changes nothing | `writeSourceSyncHeartbeat` (the 0-change sync heartbeat in preflight) |
| `brain.writeSourceUpstreamObservation(sourceId, checkedAt, commit, behind)` | `undefined`; sets `upstream_checked_at` (an ISO time; anything else refuses `invalid`), `upstream_commit` and `upstream_behind` (null allowed); an unknown source changes nothing | `writeSourceUpstreamObservation` (`recordUpstreamObservation`, after every sync) |

`upsertSource` and `setSourceArchived` are not in PGLite's engine interface; the store needs a way
to make a source, and the page methods below are source-scoped.

## Differences from the SQL engines (accepted for 1x parity)

The source members below behave differently on the Rust engine. Each difference is accepted for
1x parity. Keep this list current when a member changes.

- `config` is a map in the store. Where a SQL engine keeps a JSON string as the config, the Rust
  engine writes `{}`. On the SQL engines, a JSON-string config reads as no keys.
- `pickSoleNonDefaultSource` takes the routing rows from the request snapshot, else from a live
  `listSourceRoutingRows()` read. Both paths apply one filter: `local_path` set, id not
  `default`, not archived, role not `storage_manifest`.
- `listStaleSyncSourceIds` compares `last_sync_at` with the process clock. The SQL engines use
  the database clock (`now()`).
- `listSourceIds` reads the ids from `listSourceRecords`, archived sources included, and sorts them in
  byte order. The SQL engines sort `ORDER BY id COLLATE "C"`, the same byte order on any server
  locale.
- `readSoleSourceId` and `readFirstSourceId` read `listSourceRecords` too. The first answers the
  only id or null; the second answers `default`, else the lowest id in byte order, as the SQL
  engines' `COLLATE "C"` tie-break does. No parity case can drop `default` on a Rust brain, so
  only the SQL arms check the case without it.
- `lockAllSourceRows` takes no lock, like `lockSourceRow`. The SQL engines read every row
  `ORDER BY id FOR UPDATE` (or `FOR SHARE`).
- `lockSourceRow` reads the row from `listSourceRecords` and takes no lock. The SQL engines read
  with `FOR UPDATE`; no parity case checks that lock.
- `readSourceRow` reads from `listSourceRecords`. A caller that needs the incarnation makes one
  `readSourceIncarnation` call per source.
- `advanceSourceCommit` stamps `last_sync_at` with the process clock. The SQL engines use the
  database clock (`now()`). `getSource`, `readPlainSyncSource` and `listSourceRecords` read the
  stored `last_commit`; `listSourceRecords` also reads the stored `newest_content_at`.
- A page's embedding hold lives only in its `page_embedding_budget` ledger row
  (`page_embedding_budget.rs`, `holdPageEmbedding` and `recordPageEmbeddingHold`; docs/store/embeddings.md).
  There is no separate hold family: key tag `2` (the old `embedding_holds`) is free.
  `readPageSizeRows` reads the ledger row's `state` and `reason`, so it reports the same as the SQL
  engines (which left-join the row) and lists a page with any ledger row, of any size.
- `readReasonPurgeTombstones` sorts pairs by commit, then path, in byte order. The SQL engines
  sort them by the database collation. The callers put the pairs in a set or a map, so no caller
  reaches this difference.
- Restore-target and connector status sort sources by id in byte order on every engine.
- `insertSource` refuses an id outside `[a-z0-9-]{1,32}` with `invalid_argument`. The SQL engines
  have no check on the id column, so they accept such an id. `sources add` validates the id
  before the insert, so no caller reaches this difference.
- `insertSource` refuses a taken id or name with `constraint_violation`. The SQL engines throw the
  driver's unique-key error (`23505`). Callers treat both as a failed insert.
- `insertSource` drops a config key set to `undefined`, as the SQL engines' JSON binding does.
  The result is the same on every engine.
