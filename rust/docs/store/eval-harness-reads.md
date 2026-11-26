# Memory-trust eval harness reads

The gbrain-evals memory-trust categories (Cat 37 to 39) set up and score a brain through raw SQL.
These typed engine members replace that SQL. Their PGLite and Postgres SQL lives in
`src/core/engine-sql/eval-harness-reads.ts` and is pinned by `test/eval-harness-sql-pin.test.ts`. The
store answers them from its records (`eval_harness_reads.rs`, `eval_harness_catalog.rs`, and the
brain-mode writes in `persistence/worktrees/release.rs`). They are trusted local harness reads. They
see every source, private rows included, and no operation reaches them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getFactsByIds({ ids })` | `[{ id, source_id, fact, entity_slug, expired_at, superseded_by }]` of each stored fact in `ids`, in any source, by id. A repeated id answers once; a missing or negative id answers nothing | `getFactsByIds` |
| `brain.findLiveFactsByText({ sourceId, texts })` | `[{ id, fact }]` of the source's facts with no `expired_at` whose text equals one of `texts` byte for byte, by id | `findLiveFactsByText` |
| `brain.listPageIdSlugs()` | `[{ id, slug, source_id, deleted_at }]` of every page of every source, a soft-deleted page included, by id | `listPageIdSlugs` |
| `brain.hasTable({ table })` | whether `table` is one of the SQL tables whose records the store keeps (below) | `hasTable` |
| `brain.hasColumn({ table, column })` | whether that mapped table has the column: the record's fields, with a timestamp's `_us` suffix dropped | `hasColumn` |
| `brain.listTextBearingColumns()` | `[{ table, column, data_type, udt_name }]` for each text field the stored records carry (`text` for a string, `jsonb` for an object or array), by table then column | `listTextBearingColumns` |
| `brain.scanTextColumns({ pattern, tables?, activeOnly, limit? })` | `[{ table, column, slug, page_id, entity_slug, value }]` for each stored text value that contains `pattern`, case-insensitive, by table, column and value, at most `limit` | `scanTextColumns` |
| `brain.pauseManagedPersistence()` | the prior `{ enabled, mode_epoch }` (the epoch as text), after one write turns the brain mode's `enabled` off with no epoch bump | `pauseManagedPersistence` |
| `brain.restoreManagedPersistence({ enabled, mode_epoch })` | `true` after it puts `enabled` back, which it does only while the brain mode is still paused at `mode_epoch` (compare-and-set); `false` with nothing written otherwise | `restoreManagedPersistence` |

## What differs from the SQL engines

The store has no SQL catalog, so the catalog reads and the text scan answer from its records.

- **Mapped tables.** These SQL tables take their own name: `pages`, `content_chunks`, `facts`, `takes`,
  `timeline_entries`, `sources`, `write_gate_receipts`, `write_gate_holds`, `trust_proposals` and
  `page_purges`. `hasTable` and `hasColumn` answer from this list. They answer `true` for a mapped
  table and its columns even when the store holds no row, and `false` for every other name.
- **Every other record** takes its keyspace (`keyspaces.rs`) as its table: `<family>/<kind or records>`,
  for example `takes/take_by_row` or `core/search_postings`. This is the honest "no copy left anywhere"
  audit: the scan reads every stored record of every keyspace. As a result, the table and column names
  of these hits differ from the SQL engines, and index records such as the search postings can match.
  The tokens found and the slugs they are about are the same. `test/engine-parity/eval-harness-reads.test.ts`
  compares only those.
- **Columns.** A JSON object record is read field by field. A string field is a text column. An object
  or array field is a `jsonb` column, read as its compact JSON text (Postgres reads a `text[]` as
  `{a,b}`). Numbers and booleans are not text. Any other stored value is one text column, `value`,
  read as UTF-8. Keys are not read. A value the store keeps hex-encoded, such as a segment text, is
  not found, just as the SQL scan skips a `bytea` column.
- **Attribution.** A hit's `slug` is the record's own slug field: for a fact, `entity_slug` then
  `source_markdown_slug`; otherwise `slug`, `page_slug` or `entity_slug`. When the record has none of
  these, `slug` is the slug of the page its `page_id` names (a page's own `id`). The SQL engines use
  the same rule over their columns.
- **activeOnly.** It leaves out a record with `expired_at` or `deleted_at` set, an inactive take, and
  any record whose page is deleted. The SQL engines apply the same filters where the columns exist.
- **Case.** The pattern and each value are lowercased with `str::to_lowercase`. This agrees with
  Postgres `lower()` on ASCII text.
- **The pause.** The brain mode is one record. The pause and the restore are one store write each,
  serialized like every store write; the store keeps no file lock or mutex for them. A store with no
  brain id has no brain row, so the pause refuses.
