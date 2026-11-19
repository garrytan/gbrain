# The brain store: Sources

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A fresh brain has the `default` source: `{ id: 'default', name: 'default', local_path: null,
last_sync_at: null, config: { federated: true } }`. A row is PGLite's `SourceRow` plus
`incarnation` (a UUID that changes when a source is deleted and created again), with
`last_sync_at` as an ISO string. The record also keeps the source's `chunker_version` stamp, absent
until the first stamp; the import members read and write it ([import-members.md](import-members.md)).
It keeps the `last_commit` and `newest_content_at` the sync anchor last advanced, absent before the
first advance; `getSource`, `listSourceRecords` and the notifier reads return them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listAllSources({ includeArchived?, localPathOnly? }?)` | `SourceRow[]`, `default` first then by `id`; archived rows are left out unless `includeArchived`; `localPathOnly` keeps rows with a `local_path` that are not `config.role = 'storage_manifest'` | `listAllSources` |
| `brain.getSourceById(id)` | `SourceRow \| null`, archived rows included | `sources-ops` read by id |
| `brain.upsertSource({ id, name?, local_path?, last_sync_at?, config? })` | the `SourceRow`; only the fields given change; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `sources add` |
| `brain.updateSourceConfig(id, patch)` | `boolean`, whether the source exists; `patch` is merged one level deep, and a `null` value is kept as JSON `null` (it does not remove the key) | `updateSourceConfig` |
| `brain.setSourceArchived(id, archived)` | `boolean`, whether the source exists | `sources archive` and `restore` |
| `brain.insertSource(id, name, localPath, config)` | the new `SourceRow`; a taken `id` or `name` refuses `constraint_violation` and writes nothing; ids are 1 to 32 of `a-z0-9-` (`invalid_argument` otherwise) | `insertSource` (`sources add`) |
| `brain.advanceSourceLastCommit(id, value, { newestContentAt? })` | `boolean`, whether the source exists; one write that sets `last_commit` and `last_sync_at` (the process clock), and `newest_content_at` when the key is given (`null` clears it); archived sources advance too, and an unknown source changes nothing | `advanceSourceLastCommit` (the sync anchor) |
| `brain.readSourceLastCommit(id)` | the source's `last_commit`, archived sources included, or `null` before a sync and for a missing source | `readSourceLastCommit` (the resident notifier's `lastCommit`) |
| `brain.countRepoBoundSources()` | `number`, the sources that are not archived and have a non-empty `local_path` | `countRepoBoundSources` (the readiness sync probe) |
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
- Restore-target and connector status sort sources by id in byte order on every engine.
- `insertSource` refuses an id outside `[a-z0-9-]{1,32}` with `invalid_argument`. The SQL engines
  have no check on the id column, so they accept such an id. `sources add` validates the id
  before the insert, so no caller reaches this difference.
- `insertSource` refuses a taken id or name with `constraint_violation`. The SQL engines throw the
  driver's unique-key error (`23505`). Callers treat both as a failed insert.
- `insertSource` drops a config key set to `undefined`, as the SQL engines' JSON binding does.
  The result is the same on every engine.
