# Memory-trust eval harness reads

The gbrain-evals memory-trust categories (Cat 37 to 39) set up and score a brain through raw SQL.
These typed engine members replace that SQL. Their PGLite and Postgres SQL lives in
`src/core/engine-sql/eval-harness-reads.ts` and is pinned by `test/eval-harness-sql-pin.test.ts`. The
store answers them from its records (`eval_harness_reads.rs`, `eval_harness_catalog.rs`, and the
brain-mode writes in `persistence/worktrees/release.rs`). They are trusted local harness reads. They
see every source, private rows included, and no operation reaches them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getFactsByIds({ ids })` | `[{ id, source_id, fact, entity_slug, expired_at, superseded_by }]` of each stored fact in `ids`, in any source, by id. A repeated id answers once; a missing or negative id answers nothing. The Rust member refuses an id that is not a safe integer | `getFactsByIds` |
| `brain.findLiveFactsByText({ sourceId, texts })` | `[{ id, fact }]` of the source's facts with no `expired_at` whose text equals one of `texts` byte for byte, by id | `findLiveFactsByText` |
| `brain.listPageIdSlugs()` | `[{ id, slug, source_id, deleted_at }]` of every page of every source, a soft-deleted page included, by id | `listPageIdSlugs` |
| `brain.hasTable({ table })` | whether `table` is one of the SQL tables whose records the store keeps (below) | `hasTable` |
| `brain.hasColumn({ table, column })` | whether that mapped table has the column: the record's fields, with a timestamp's `_us` suffix dropped, plus `trust_tier` and `write_origin` of `takes` and `timeline_entries` (kept in their nested `trust` record) | `hasColumn` |
| `brain.listTextBearingColumns()` | `[{ table, column, data_type, udt_name }]` for each text field the stored records carry (`text` for a string, `jsonb` for an object or array), by table then column (the SQL engines list a table's columns by position) | `listTextBearingColumns` |
| `brain.scanTextColumns({ pattern, tables?, activeOnly, limit? })` | `[{ table, column, slug, page_id, entity_slug, value }]` for each stored text value that contains `pattern`, case-insensitive, by table, column and value, then the slug, page id and entity of a tie, in UTF-8 byte order with a missing one first, at most `limit`. An empty `pattern`, or a `limit` that is not a whole number of zero or more, is refused | `scanTextColumns` |
| `brain.pauseManagedPersistence()` | the prior `{ enabled, mode_epoch, topology_changes }` (the epoch and the count of stored brain-wide topology changes, `source_id` `*`, as text), after one write turns the brain mode's `enabled` off with no epoch bump | `pauseManagedPersistence` |
| `brain.restoreManagedPersistence({ enabled, mode_epoch, topology_changes })` | `true` after it puts `enabled` back, which it does only while the brain mode is still paused at `mode_epoch` and the store holds `topology_changes` brain-wide topology changes (compare-and-set; a change to one source does not count); `false` with nothing written otherwise | `restoreManagedPersistence` |

## What differs from the SQL engines

The store has no SQL catalog, so the catalog reads and the text scan answer from its records.

- **Mapped tables.** These SQL tables take their own name: `pages`, `content_chunks`, `facts`, `takes`,
  `timeline_entries`, `sources`, `write_gate_receipts`, `write_gate_holds`, `trust_proposals`,
  `page_aliases` (its `source_id`, `alias_norm`, `slug` and `origin`; the `case_sensitive` and
  `alias_text` of a derived alias are in the page-side copy, which keeps its keyspace name) and
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
  `{a,b}`). A number or boolean is text only in a jsonb field (the `jsonb::de_value` fields,
  listed in `JSONB_FIELDS`), as the SQL scan reads a whole jsonb `42` as `42`; any other number or
  boolean is a SQL number or boolean column, not text. A config row is raw text (it may parse as
  JSON), so it is one text column, `value`, read as UTF-8, as is any other stored value that is not
  a JSON object. Keys are not read, except the text columns some keys hold: a config row's `key`, a
  `page_purges` key's `source_id` and `content_hash`, and a `page_aliases` row's four columns (its
  value is empty). A value the store keeps hex-encoded, such as a segment text, is not found,
  just as the SQL scan skips a `bytea` column.
- **Attribution.** A hit's `slug` is the record's own slug field: for a fact, `entity_slug` then
  `source_markdown_slug`; otherwise `slug`, `page_slug` or `entity_slug`. When the record has none of
  these, `slug` is the slug of the page its `page_id` names (a page's own `id`, a wanted link's
  `origin_page_id`). A page alias row is about the slug in its key. The SQL engines use the same rule
  over their columns.
- **activeOnly.** It leaves out a record with `expired_at` or `deleted_at` set, a fact past its
  `valid_until`, an inactive take, and any record whose page is deleted: by its `page_id`, a wanted
  link's `origin_page_id`, a page id in its key (the page id index, the page body rows and the sealed
  search timeline), for a fence fact by its `source_id` and `source_markdown_slug`, or for a page
  alias by the source and slug in its key. It also leaves out the derived index keyspaces (search
  postings, trigrams, vectors, link and timeline indexes, chunk and timeline query state): what they
  copy is read from the records they index, and a deleted page's index entries cannot be told from a
  live one's by their values. The link query keyspace is read: it holds the wanted links and the link
  relationships and transitions themselves (the SQL tables of the last two have no `page_id`, so
  neither scan filters them). The SQL engines apply the same filters where the columns exist.
- **Order and limit.** Hits are sorted by table, column and value, then the slug, page id and entity
  of a tie, in UTF-8 byte order with a missing one first, as the SQL engines sort them
  (`convert_to(..., 'UTF8') NULLS FIRST`), so a limit keeps the same hits. The scan keeps at most `limit` hits while it
  reads. It reads only the id, source, slug and deletion of each page, not its body.
- **Case.** The pattern and each value are lowercased with `str::to_lowercase`. This agrees with
  Postgres `lower()` on ASCII text.
- **The pause.** The brain mode is one record. The pause and the restore are one store write each,
  serialized like every store write; the store keeps no file lock or mutex for them. A store with no
  brain id has no brain row, so the pause refuses. The restore also compares the count of stored
  brain-wide topology changes (`source_id` `*`): a deactivation of a disabled brain that releases
  claims records one without moving the epoch, so the restore keeps it. A change to one source (an
  add, a claim, a removal, a company-brain connect) is not counted, so it does not stop the restore.
  A deactivation that releases no claims writes no change, so the restore turns the brain back on.
  When the callback throws and the restore also fails, the caller gets both errors: the restore error
  is attached to the callback's error as `restoreError`, or, when that error is not an object or is
  frozen, both are in an `AggregateError`.

## The pause contract and its known risks

`withManagedPersistencePaused` is the eval harness's hook only: one pause at a time per brain. It
refuses a second pause on the same engine object while one is held (`managed_pause_held`). Nothing
records a pause, so these risks remain, by design:

- **No record of who paused.** Pauses through two engine objects or two processes are not seen.
- **Overlapping pauses restore too early.** When two such pauses overlap, the first restore turns
  persistence back on while the second callback still runs.
- **A lost pause reply.** When the process dies, or the owner socket drops the reply, before the
  restore, the brain stays at `enabled=false` at the same epoch.

The recovery for all three is `gbrain sources writer activate`, which turns managed persistence back
on and moves the epoch. The restore runs outside the request's abort signal and the read and statement
deadlines, so a cancelled request or a callback that outlasts its deadline does not leave the brain
paused. On the SQL engines the pause takes the brain row lock before it reads the prior state, so a
change that commits while it waits is in the snapshot. The restore takes the brain row lock first and then runs the compare-and-set in a
later statement of the same transaction, so it sees a deactivation that committed while it waited.
