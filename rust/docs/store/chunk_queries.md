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

The store keeps every body inline, so the segmented branches of the SQL engines (ordinal paging, occurrence
references, the body manifest) never apply. It has no `chunker_version` column: a page's chunks are sealed when its
`text_projection_revision` equals its `knowledge_revision`, the test the SQL engines' served-projection filter makes.
`sealChunks` sets that revision, and a body write moves the knowledge revision, so the old chunks stop reading.

## getChunkPage

The page is found as `getChunks` finds it: the slug as written (no case fold), in the one source the member resolves
(`sourceIds` when not empty, else `sourceId`, default `default`), and a soft-deleted page is read like a live one. An
unsealed or absent page answers `{ chunks: [], total_chunks: 0, max_chunk_index: null }`. Otherwise `total_chunks`
counts every chunk of the page, `max_chunk_index` is the highest index, and `chunks` holds the chunks with
`fromIndex <= chunk_index < fromIndex + limit` in index order, decoded with the shared `toChunk`.

A scope that names no source answers no chunks without a store call. A scope of several sources refuses: the SQL
engines sum the counts of every matching page and order the chunks by a key that ties across sources.

## getChunkWindows

An empty request list answers `[]` before any option is read. Otherwise a requested page is authorized when it
exists, is in scope (a non-empty `sourceIds`, else a non-empty `sourceId`, else every source), is live, is sealed,
its source is not archived and its frontmatter has no `quarantine` key. Unauthorized pages are absent.

Each authorized page yields one page row: `prio` is the lowest priority any request gave it, `max_chunk_index` is the
highest index over all its chunks (any chunk source), `sealed` is true (authorization already required it) and
`segmented` is false. Chunk rows come from the authorized pages: a chunk whose `chunk_source` is in `chunkSources`,
whose modality is `text` and whose index is inside some request's inclusive range for that page. They are ordered by
`(prio, page_id, chunk_index)` and cut at `maxRows + 1`, so `mapChunkWindowRows` can mark `row_limited`.

The TypeScript member floors `maxRows` and clamps it at zero as the SQL engines do. A request field that is not a
safe integer, or a `maxRows` that is not finite, refuses: Postgres casts the values into `int[]` and `LIMIT`, and
the store does not guess at that cast.

## The chunkless reads

A page counts when it is live, has a non-empty `compiled_truth` or `timeline`, has no `quarantine` frontmatter key,
has no chunk rows, and either is not sealed or carries `embed_skip`. A page sealed with no chunks does not count.
`sourceId` scopes the read only when it is a non-empty string, as the SQL truthiness test does.

The list returns `{ id, slug, source_id, compiled_truth, timeline }` in page-id order, after `afterPageId` when it is
given, at most `batchSize` rows (default 50). A negative or fractional `batchSize`, or a fractional
`afterPageId`, is an `invalid_argument`; Postgres rejects a negative `LIMIT` too.

## Known differences

- `sealed` is derived from the projection revision, not `chunker_version`. A Postgres page whose current projection
  predates the protected-body fence reads `sealed: false` there and `true` here. The store has no such pages: it was
  created after the fence.
- The activation sentinel revision (`ACTIVATION_SERVED_REVISION`) of the served-projection filter does not exist in
  the store.
