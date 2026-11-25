# The brain store: Raw data and files

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Raw source data attached to pages (`raw_data`) and file metadata (`files`). JSONB values (`data`,
`metadata`) cross the binding as the `JSON.stringify` text PGLite binds, so `undefined` members drop and
`toJSON` values (a `Date`) turn into their JSON form exactly as on PGLite. The store keeps them in jsonb key
order (object keys by length, then bytes), as Postgres returns them. Timestamps leave as ISO strings; the
TypeScript members turn them into `Date`s.

Keys (tag `r`, `keys::RAW_FILES`):

| Key | Value | Mirrors |
| --- | --- | --- |
| `r 0x01 <page id u64 BE> 0x00 <source name>` | raw data record: `id`, `page_id`, `source`, `data`, `fetched_at` | `raw_data`, `UNIQUE(page_id, source)` |
| `r 0x02 <storage path>` | file record: every `files` column | `files`, `UNIQUE(storage_path)` |
| `r 0x03 <page id u64 BE> 0x00 <file id u64 BE>` | the file's storage path | `idx_files_page_id` |

File ids come from the counter `M next_file_id` and raw data ids from `M next_raw_data_id`. A refused
insert takes no id and an update keeps the row's id. `files` is unique on `storage_path` across every
source, so the path alone is the file key and `source_id` is a field of the record. (The interfaces plan wrote `r 0x02 <source> 0x00 <storage path>`;
that key would let two sources hold one path, which Postgres refuses.) A fact purge's probe names a raw data row
by its `raw_data.id` (`raw_data:<id> <slug> <source>`). A record written before the store kept that id has
none until its next `putRawData`, which gives it one; until then naming it refuses.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.putRawData(slug, source, dataJson, { sourceId? }?)` | `null`. Inserts or replaces the row of (page, source) and stamps `fetched_at`. With a `sourceId` (not empty) only that source's page; without one, every page by that slug in any source. Soft-deleted pages count. No page: `page_not_found` with PGLite's message (`putRawData failed: page "<slug>" not found`, or `... (source=<id>) not found`). A null `source` or `dataJson` on a found page: `constraint_violation`. A NUL byte in text or a `\u0000` in the JSON: `invalid_argument` | `putRawData` |
| `brain.getRawData(slug, source?, { sourceId?, sourceIds?, includeDeleted? }?)` | `{ source, data, fetched_at }[]` of every page by that slug in scope (`sourceIds` when not empty, else `sourceId` when not empty, else every source), only `source` when it is given and not empty. Soft-deleted pages are skipped unless `includeDeleted`. Rows come in SQL's order, page source then raw-data source, both byte-wise; a repeated `sourceIds` entry reads once | `getRawData` |
| `brain.upsertFile(spec)` | `{ id, created }`. `spec` is a `FileSpec` with `metadata` as JSON text; `source_id` is `default` when absent. When a file already has that `storage_path` (in any source) every column but `id`, `source_id` and `created_at` is replaced and `created` is false. A new row needs its source and page to exist; an update checks the page only when `page_id` changes. `constraint_violation` for a null `filename`, `storage_path`, `content_hash` or `metadata`, or a missing source (`files_source_id_fkey`) or page (`files_page_id_fkey`); `invalid_argument` for a NUL byte, a `page_id` that is not a whole `integer`, or a `size_bytes` that is not a whole `bigint` | `upsertFile` |
| `brain.getFile(sourceId, storagePath)` | the `FileRow` at that path when it belongs to `sourceId`, else `null` | `getFile` |
| `brain.listFiles(pageSlug, limit)` | `FileRow[]`: with a `pageSlug` (not `null`), the files of that slug in any source by `filename`; with `null`, every file by `page_slug` (files with no slug last), then `filename`. Ties go by id. At most `limit`, which must be a whole `integer` and not negative (`invalid_argument` otherwise); a NUL byte in `pageSlug` is `invalid_argument` | `listFiles` |
| `brain.listFilesForPage(pageId)` | `FileRow[]` whose `page_id` is `pageId`, `created_at ASC`. `pageId` must be a whole `integer` (`invalid_argument` otherwise); one that names no page lists nothing | `listFilesForPage` |

`FileRow.size_bytes` is a number. A size past 2^31 crosses N-API as a double; the store takes any whole
double inside the `bigint` range.

Cascades:

- Page hard delete (`remove_page_rows`): deletes the page's raw data (`ON DELETE CASCADE`) and sets
  `page_id` to null on its files (`ON DELETE SET NULL`). The file rows and their `page_slug` stay.
  Soft delete changes nothing here; `getRawData` hides the rows of a soft-deleted page.
- Page rename (`updateSlug`, `aliases.rs`): `rename_page_files` gives the page's files named by the old slug the new
  `page_slug`, finding them through the `r 0x03` page index, so only rows bound by `page_id` move. A file with no
  `page_id` stays, as on PGLite.
- Source delete (`remove_source_rows`): deletes the files of that source and their page index entries.
  Raw data hangs off pages, so the page hook removes it. Files are keyed by path, so the hook scans every
  file record.

Differences from PGLite:

- `listFilesForPage`: equal `created_at` stamps come in no fixed order on PGLite; the store breaks ties by
  id.
- `listFiles`: the store sorts `page_slug` and `filename` by bytes, as PGLite's C collation does; a Postgres
  database with another collation (`en_US.UTF-8`) can order mixed-case or punctuated names differently.
- `upsertFile`: Postgres takes a serial id even when the insert turns into an update, so its ids can skip
  numbers. The store takes an id only for a new row. No caller reads id gaps.
- `getRawData` with `excludePrivate`: the TypeScript member sends the caller's page policy (reader
  identity and private-readable grant included), and a page it hides has no raw data. A caller whose
  policy differs in any other way gets `engine_capability_missing`. PGLite's `getRawData` ignores the
  other `PageReadScope` options, and so does the member.

## Files commands and file operations (`src/core/engine-sql/files-ops.ts`)

Twenty-one members for the statements `gbrain files` (`src/commands/files.ts`) and the file operations (`src/core/ops/files.ts`)
ran as raw SQL. Rust serves all twenty-one: `sourceIdExists` and `readSourceLocalPathForVerify` from `files-sources.ts`, and
the other nineteen from `store-members/files-ops.ts`, through `src/raw_files/ops.rs` and the napi family `files_ops.rs`.
Each reads the typed arguments; the store never sees the statement.

| Members | Served as |
| --- | --- |
| `listFileRowsForVerify` | a scan of the `r 0x02` records ordered by `storage_path`, 1000 rows (`files list` is the served `listFiles`); `size_bytes` as a number, `metadata` as the object |
| `hasFileWithHash` | the record at the path and a compare of its `content_hash` |
| `upsertCliFileRow`, `upsertRawFileRow`, `upsertSyncFileRow` | `upsertFile`'s write plus the metadata merge: the new keys over the old object (a stored value that is not an object reads as `{}`), then jsonb key order. The raw lane names `source_id`; the others take `default`. `upsertCliFileRow` and `upsertRawFileRow` bind the live page at `page_slug` in that source (`page_id`, as PGLite's `(SELECT id FROM pages WHERE source_id = .. AND slug = .. AND deleted_at IS NULL)`); `upsertSyncFileRow` binds none. A repeat updates the hash, size and type, and, when the row bound a page, takes the page's id and slug together (a row that binds none keeps its pair) |
| `upsertOpFileRow` | the same write; the row names the page's slug as it is now, read by its id (a page renamed while the bytes uploaded is listed under its new slug), else the slug given; on a repeat the source, page id and slug change only when the new row names a page (`source_id` kept, `page_id` coalesced, `page_slug` kept otherwise) |
| `registerFileRow` | insert, or refresh only when `page_slug`, `filename`, `source_id` and `page_id` all match (null equals null); false leaves the row alone |
| `readFileOwner`, `claimFilePage`, `countFilesRegisteredElsewhere` | the record at the path; a source and page update that keeps the `r 0x03` page index in step; a count of 0 or 1 (a null filename never differs) |
| `readPageIdInSource` | the page record by slug and source, soft-deleted pages included, as the statement did not filter them |
| `listReadableFileRows`, `readReadableFileForUrl`, `listReadableFilePaths`, `readReadableFileForVerify`, `countUnreadableFilesAt`, `readReadablePageId` | the caller's page policy (the member renders it as `storePagePolicy` does for the other served reads) applied to a file's page by id and by slug in every source; the filter runs before the limit of 100 |

A write that names a source or a page that does not exist is a `constraint_violation` with nothing written, as the foreign keys
refuse it on Postgres. `metadata` that is not an object, an `undefined` or object bind value and text with a NUL are refused by
name, as the SQL engines' own binders refuse them.

Differences from PGLite, all in order or ties and none in what a caller can see for ordinary names:

- Text sorts by byte, as PGLite's does. A Postgres database with a locale collation orders some names differently (a hyphen,
  a capital); the parity cases use names that agree.
- Rows that tie on the sort key come back in storage-path order. The statements leave ties unordered, so PGLite and Postgres
  return them in heap order.
- A soft-deleted private page still hides its files, and a private page at the slug in any source hides a file that names only
  the slug, because the statements test neither `deleted_at` nor the source.

The hand-numbered placeholders of the readable statements (`$1` limit after a `$2` slug), the inlined metadata merge text
and the four vetted builders are Postgres text only; the store reads the typed arguments, never the statement.
