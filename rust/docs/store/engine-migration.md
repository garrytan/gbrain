# The brain store: engine migration reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The reads `gbrain migrate --to <engine>` makes of the brain it moves, so a Rust brain can be the source of a migration. The TypeScript statements are in `src/core/engine-sql/engine-migration.ts`; the store module is `rust/crates/gbrain-store/src/engine_migration.rs` (the manual link statements live with the transitions, in `link_queries/link_temporal.rs`), the binding `rust/crates/gbrain-napi/src/families/engine_migration.rs` and the members `src/core/rust-engine/store-members/engine-migration.ts`. The target side of a migration is always a SQL engine and stays raw SQL.

| JS | Resolves |
| --- | --- |
| `brain.readEngineMigrationHistory()` | `{ held, pageVersions }`. `held` names the history tables with a row, in the order the refusal names them: `persistence_requests` when a write request (`J`) is recorded, `fact_withdrawals` when a withdrawal (`t 0x01`) is recorded. `pageVersions` counts the `V` keys |
| `brain.readMigrationRows(table)` | `{ columns, rows }` for `facts` (every fact as `SELECT *` reads it, `embedding` as vector text, by id), `open_loops` (every loop row, by id) and `loop_suppressions` (every mute, by source, kind and value in byte order; the SQL read orders by id). Another table refuses `INVALID_ARGUMENT` |
| `brain.listManualLinkTransitions(sourceId, slug)` | `{ to_slug, to_source_id, link_type, kind, occurred_on }` for each `manual` statement of a relationship the page starts, in any deletion state, by target source, target slug, link type, kind and day (byte order). No page: `[]` |
| `brain.countLiveTimelineEntries()` | the timeline rows of pages that are not soft-deleted |

The members compose two reads in TypeScript from methods the store already serves:

- `readMigrationRows('sources')` maps `listSourceRecords()` to the 13 columns the copier carries. `config_json` is the config as JSON text.
- `readMigrationPageColumns(slug, sourceId)` reads `readPageSnapshot(slug, { sourceId, includeDeleted: true })` and takes the origin, kind and provenance columns. `sealed` is true when the text projection revision equals the knowledge revision (two missing revisions are equal, as `IS NOT DISTINCT FROM` says).

All five members are reported under the capability of their family: `persistence_journal`, `sources`, `pages`, `links` and `timeline`.

Differences from the SQL engines:

- The store keeps no source commit or frontmatter-trust flag. A migrated source gets `last_commit` null and `trust_frontmatter_overrides` false, as a fresh source row has them. Its `archived_at` and `archive_expires_at` come from `listArchivedSourceRows` (null for an active source and for an archive with no times). Its `contextual_retrieval_mode` is the stored override, read through `getSource`. A source with no name takes its id as its name.
- A mute keeps its id and `created_at`. The store takes a mute id on every add, also one that lands on an existing row, as `nextval` does before `ON CONFLICT`.
- The store records no belief events and no persistence worktrees, so `held` never names `belief_events` or `persistence_worktrees`.
- A plain `putPage` writes no write request and no page version on the store, so a brain written only through page writes migrates. `createVersion` writes a version, and the migration then refuses with the page-history message, as on PGLite.
- When a Rust brain holds history the copier would drop, the refusal keeps the brain on the Rust engine and changes nothing (`engineMigrationFix`, `src/core/persistence/maintenance.ts`).
- `facts` and `open_loops` carry the columns the store keeps. The copier intersects them with the target's columns, so a column the store does not keep takes the target's default.
