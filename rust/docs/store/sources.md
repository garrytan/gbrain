# The brain store: Sources

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A fresh brain has the `default` source: `{ id: 'default', name: 'default', local_path: null,
last_sync_at: null, config: { federated: true } }`. A row is PGLite's `SourceRow` plus
`incarnation` (a UUID that changes when a source is deleted and created again), with
`last_sync_at` as an ISO string. The record also keeps the source's `chunker_version` stamp, absent
until the first stamp; the import members read and write it ([import-members.md](import-members.md)).
The source's own contextual-retrieval mode sits beside the record ([source-cr-mode.md](source-cr-mode.md));
the `getSource` member and the engine migration's `sources` read add it.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listAllSources({ includeArchived?, localPathOnly? }?)` | `SourceRow[]`, `default` first then by `id`; archived rows are left out unless `includeArchived`; `localPathOnly` keeps rows with a `local_path` that are not `config.role = 'storage_manifest'` | `listAllSources` |
| `brain.getSourceById(id)` | `SourceRow \| null`, archived rows included | `sources-ops` read by id |
| `brain.upsertSource({ id, name?, local_path?, last_sync_at?, config? })` | the `SourceRow`; only the fields given change; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `sources add` |
| `brain.updateSourceConfig(id, patch)` | `boolean`, whether the source exists; `patch` is merged one level deep, and a `null` value is kept as JSON `null` (it does not remove the key) | `updateSourceConfig` |
| `brain.setSourceArchived(id, archived)` | `boolean`, whether the source exists; archiving sets no archive time (an unverified archive the purge sweep never deletes), un-archiving clears both times | test fixtures |
| `brain.archiveSource(id, ttlHours)` | `{ id, name, archived_at, archive_expires_at } \| null`; an active source is archived now with its expiry `ttlHours` later and `config.federated` false; a missing or archived source changes nothing | `archiveSource` (`sources archive`) |
| `brain.restoreArchivedSource(id, federated)` | `boolean`, whether an archived source was restored; both archive times are cleared and `config.federated` is set | `restoreArchivedSource` (`sources restore`) |
| `brain.listArchivedSourceRows()` | every archived source with `page_count` (soft-deleted pages included), newest `archived_at` first; a source with no archive time comes first, equal times by id descending | `listArchivedSourceRows` (`sources archived`) |
| `brain.listExpiredArchivedSources()` | `{ id, incarnation, config, local_path }[]` by id: both archive times after `1970-01-02` UTC and the expiry passed | `listExpiredArchivedSources` (the purge sweep) |
| `brain.listUnverifiedArchivedSourceIds()` | the archived source ids, by id, with either time missing or at or before `1970-01-02` UTC | `listUnverifiedArchivedSourceIds` (the purge sweep's report) |
| `brain.readSourceDeleteImpact(id)` | `{ id, name, pages, chunks, embeddings, files, facts } \| null`; pages include soft-deleted ones, `embeddings` counts chunks with a vector, `files` counts the source's files | `readSourceDeleteImpact` (the `sources remove` preview and the destructive guard) |
| `brain.deleteSourceRecord(id, expiredArchiveOnly)` | `boolean`, whether the source was deleted: a missing source, or with `expiredArchiveOnly` one that is not an archive past its window, changes nothing; in one write transaction it removes every page (`pages::remove_page`), the `cascade::remove_source_rows` list, the source's `managed-sync` cursors, its write gate holds with their receipts, its writer binding when it binds the deleted incarnation (`persistence::remove_source_binding_in`; the worktree and host bindings stay, as on Postgres), and each eval candidate's retrieved slug no other covered source has; an OAuth client whose `source_id` names the source (revoked ones too) refuses `constraint_violation` with the foreign-key message and changes nothing; a client whose `bound_source_id` names it gets null | `deleteSourceRecord` (`deleteSourceRow`: `sources remove`, the purge sweep) |
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
  (`holdPageEmbedding`, key tag `2`). The spend columns (signature, spent, reserved, cap) have no
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
- The archive times use the process clock. The SQL engines use the database clock (`now()`).
- `listExpiredArchivedSources` and `listUnverifiedArchivedSourceIds` sort ids by bytes. The SQL
  engines sort with the database collation; source ids are `a-z0-9-` only, but under `en_US` a
  hyphen can sort differently.
- `listArchivedSourceRows` breaks equal archive times by id, greatest first, in byte order, as the
  SQL engines now do (`s.id COLLATE "C" DESC`).
- `deleteSourceRecord` always removes the pages, as the `pages -> sources` cascade does, so it
  never reports `stranded` pages (the SQL engines report them when that cascade would not fire,
  #7072). The store keeps no `persistence_source_bindings`, retrieval events or feedback,
  `context_volunteer_events` or `core_edit_notices`, so those steps of the SQL delete have nothing
  to remove. The SQL engines run the scrub again in a second statement for a write that waited on
  the delete; the store's one write transaction leaves no such gap.
