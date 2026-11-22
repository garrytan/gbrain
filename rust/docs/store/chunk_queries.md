# chunk_queries: chunk pages, chunk windows and chunkless pages

Code: `rust/crates/gbrain-store/src/chunk_queries.rs`, the napi methods in
`rust/crates/gbrain-napi/src/families/chunk_queries.rs` and the members in
`src/core/rust-engine/store-members/chunk-queries.ts`. The reference is
`src/core/engine-sql/chunks.ts`.

## Members

| Member | State |
|---|---|
| `getChunkPage(slug, { sourceId?, sourceIds?, fromIndex, limit })` | served for one named source |
| `getChunkWindows(requests, { sourceId?, sourceIds?, chunkSources, maxRows })` | served; the TypeScript member groups the rows with the shared `mapChunkWindowRows` |
| `countChunklessPagesWithContent({ sourceId? })` | served |
| `listChunklessPagesWithContent({ sourceId?, batchSize?, afterPageId? })` | served |

`excludePrivate: true` and `requireSafeChunks: true` refuse on `getChunkPage` and `getChunkWindows`: the SQL engines
apply a privacy filter for the first and a `chunker_version` fence for the second, and the store records neither.
`minTrust` and `suppressFlagged` are ignored, because those SQL statements ignore them too.

## Keys

None. Every member reads pages, chunks and sources through their families' `pub(crate)` readers and writes nothing,
so no record starts with the `c` tag.

## Sealed chunks

A segmented page is one whose body columns are NULL, the shell `createSegmentedPageShell` leaves. Its chunks are read
through the page's live generation, as the SQL engines' `chunkVisibleFilter` and `chunkGenerationFilter` do: a chunk
staged for a later generation, and one of a retired occurrence, are not read, so staged draft text shows nowhere and
moves no total or max index before the flip. An inline chunk left on a segmented page is not part of its live body.
A page's chunks are served (`getChunkPage`, `getChunkWindows`) when its `text_projection_revision` equals its
`knowledge_revision` or is the v153 activation marker, the test the SQL engines' `servedTextProjectionFilter` makes.
The chunkless reads count a page as sealed only when the two revisions are equal, as `chunklessPagesWhere` does.
`sealChunks` sets that revision, and a body write moves the knowledge revision, so the old chunks stop reading.

## getChunkPage

The page is found as `getChunks` finds it: the slug as written (no case fold), in the one source the member resolves
(`sourceIds` when not empty, else `sourceId`, default `default`), and a soft-deleted page is read like a live one. An
page that is not served, or is absent, answers `{ chunks: [], total_chunks: 0, max_chunk_index: null }`. Otherwise `total_chunks`
counts every visible chunk of the page, and `chunks` holds the visible chunks, decoded with the shared `toChunk`.
An inline page is paged by `chunk_index`: `max_chunk_index` is the highest index and `chunks` holds those with
`fromIndex <= chunk_index < fromIndex + limit` in index order. A page with a segmented chunk is paged by position in
document order (manifest `byte_start`, then `local_ordinal`, then `chunk_index`; an insertion sequence leaves gaps and
does not follow the document): `chunks` holds the positions `fromIndex <= position < fromIndex + limit` and
`max_chunk_index` is the visible count less one.

A scope that names no source answers no chunks without a store call. A scope of several sources refuses: the SQL
engines sum the counts of every matching page and order the chunks by a key that ties across sources.

## getChunkWindows

An empty request list answers `[]` before any option is read. Otherwise a requested page is authorized when it
exists, is in scope (a non-empty `sourceIds`, else a non-empty `sourceId`, else every source), is live, is served,
its source is not archived and its frontmatter has no `quarantine` key. Unauthorized pages are absent.

Each authorized page yields one page row: `prio` is the lowest priority any request gave it, `max_chunk_index` is the
highest index over all its chunks of the live body (any chunk source), `sealed` is `COALESCE(chunker_version, 0) >= 4`
(`SAFE_FENCE_CHUNKER_VERSION`; a page that records no version is not sealed, as in SQL) and `segmented` is true
for a page with NULL body columns. A segmented page's row carries NULL `compiled_truth` and `timeline`. Chunk rows
come from the authorized pages that are sealed: a chunk of the live body (above) whose `chunk_source` is in `chunkSources`,
whose modality is `text` and whose index is inside some request's inclusive range for that page. They are ordered by
`(prio, page_id, chunk_index)` and cut at `maxRows + 1`, so `mapChunkWindowRows` can mark `row_limited`. A segmented
chunk's row carries its manifest `occurrence_id` (null for an inline chunk), which segmented evidence maps to the
manifest row.

The TypeScript member floors `maxRows` and clamps it at zero as the SQL engines do. A request field that is not a
safe integer, or a `maxRows` that is not finite, refuses: Postgres casts the values into `int[]` and `LIMIT`, and
the store does not guess at that cast.

## The chunkless reads

A page counts when it is live, has a non-empty `compiled_truth` or `timeline` (or is segmented with `body_bytes > 0`;
`body_bytes` is the size the page's last flip published, read from the page_body family's body state), has no `quarantine` frontmatter key,
has no chunk rows, and either is not sealed or carries `embed_skip`. A page sealed with no chunks does not count.
`sourceId` scopes the read only when it is a non-empty string, as the SQL truthiness test does.

The list returns `{ id, slug, source_id, compiled_truth, timeline }` in page-id order (a segmented page's NULL body
columns as `""`), after `afterPageId` when it is
given, at most `batchSize` rows (default 50). A negative or fractional `batchSize`, or a fractional
`afterPageId`, is an `invalid_argument`; Postgres rejects a negative `LIMIT` too.

## Known differences

- `sealed` is `COALESCE(chunker_version, 0) >= 4`, as in SQL: a page with no recorded version reads `sealed: false`.
  `sealChunks` stamps version 4, even for an empty chunk list. A put that chunks the page (its own raw split of the
  body, or the `chunks` it was given) seals the text projection but does not stamp 4: no sanitizer read those chunks,
  so the page stays below the fence (stamped -1 when it changes the chunks or sits below 4, else left) until a
  `sealChunks` of sanitized chunks. An `upsertChunks`
  that changes a chunk (text, source or modality, a given metadata value, or an added or dropped index) stamps -1,
  and one that repeats the stored chunks leaves the stamp, as `chunkWriteInvalidations` does.
- The activation sentinel revision (`ACTIVATION_SERVED_REVISION`) of the served-projection filter does not exist in
  the store.
