# The brain store: Sources

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A fresh brain has the `default` source: `{ id: 'default', name: 'default', local_path: null,
last_sync_at: null, config: { federated: true } }`. A row is PGLite's `SourceRow` plus
`incarnation` (a UUID that changes when a source is deleted and created again), with
`last_sync_at` as an ISO string. The record also keeps the source's `chunker_version` stamp, absent
until the first stamp; the import members read and write it ([import-members.md](import-members.md)).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listAllSources({ includeArchived?, localPathOnly? }?)` | `SourceRow[]`, `default` first then by `id`; archived rows are left out unless `includeArchived`; `localPathOnly` keeps rows with a `local_path` that are not `config.role = 'storage_manifest'` | `listAllSources` |
| `brain.getSourceById(id)` | `SourceRow \| null`, archived rows included | `sources-ops` read by id |
| `brain.upsertSource({ id, name?, local_path?, last_sync_at?, config? })` | the `SourceRow`; only the fields given change; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `sources add` |
| `brain.updateSourceConfig(id, patch)` | `boolean`, whether the source exists; `patch` is merged one level deep, and a `null` value is kept as JSON `null` (it does not remove the key) | `updateSourceConfig` |
| `brain.markSourceSynced(id)` | `boolean`, whether the source exists; sets `last_sync_at` to the store clock at the moment of the write (`now()` on the SQL engines), and an unknown id changes nothing | `markSourceSynced` |
| `brain.setSourceArchived(id, archived)` | `boolean`, whether the source exists | `sources archive` and `restore` |
| `brain.insertSource(id, name, localPath, config)` | the new `SourceRow`; a taken `id` or `name` refuses `constraint_violation` and writes nothing; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `insertSource` (`sources add`) |
| `brain.countRepoBoundSources()` | `number`, the sources that are not archived and have a non-empty `local_path` | `countRepoBoundSources` (the readiness sync probe) |
| `brain.holdPageEmbedding(pageId, reason)` | `null`; sets the page's embedding hold to `{ state: 'held', reason }`, replacing a held reason; an unknown page id refuses `page_not_found`; a hard page delete drops the hold | `holdPageEmbedding` (page-embedding-budget.ts) |
| `brain.readReasonPurgeTombstones(sourceId, pair)` | `{ commit_sha, path }[]`, the source's purged change-reason pairs by commit then path, or only `pair` (when not `null`) if it is stored | `readReasonPurgeTombstones` (`reason_purge_tombstones`) |
| `brain.writeReasonPurgeTombstones(sourceId, pairs)` | `number`, the pairs added; a stored or repeated pair adds nothing; an unknown source refuses `source_not_found` and stores nothing; a source delete drops its pairs | `writeReasonPurgeTombstones` (facts purge) |
| `brain.countSourcePages(sourceId, includeDeleted)` | `number`, the source's pages; soft-deleted pages count only with `includeDeleted`; an unknown source has none | `countSourcePages` (`sources list`, `status`, `remove`) |

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
- `lockSourceRow` reads the row from `listSourceRecords` and takes no lock. The SQL engines read
  with `FOR UPDATE`; no parity case checks that lock.
- `readSourceRow` reads from `listSourceRecords`. A caller that needs the incarnation makes one
  `readSourceIncarnation` call per source.
- `advanceSourceCommit` stamps `last_sync_at` with the process clock. The SQL engines use the
  database clock (`now()`). `getSource`, `readPlainSyncSource` and `listSourceRecords` read the
  stored `last_commit`; `listSourceRecords` also reads the stored `newest_content_at`.
- The store keeps only the `state` and `reason` of a page's `page_embedding_budget` row
  (`holdPageEmbedding`, key tag `h`). The spend columns (signature, spent, reserved, cap) have no
  record: the embedding plan that writes them still runs raw SQL and refuses on this engine.
  `readPageSizeRows` reads the kept hold, so it reports the same `state` and `reason` as the SQL
  engines and lists a held page of any size.
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
