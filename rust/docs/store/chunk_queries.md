# chunk_queries: chunk pages, chunk windows and chunkless pages

Code: `rust/crates/gbrain-store/src/chunk_queries.rs` (the site reads in `chunk_queries/site_reads.rs`), the napi
methods in `rust/crates/gbrain-napi/src/families/chunk_queries.rs` and the members in
`src/core/rust-engine/store-members/chunk-queries.ts`. The references are `src/core/engine-sql/chunks.ts` and
`src/core/engine-sql/chunk-reads.ts`.

## Members

| Member | State |
|---|---|
| `getChunkPage(slug, { sourceId?, sourceIds?, fromIndex, limit, excludePrivate?, requireSafeChunks? })` | served for one named source |
| `getChunkWindows(requests, { sourceId?, sourceIds?, chunkSources, maxRows, excludePrivate?, requireSafeChunks? })` | served; the TypeScript member groups the rows with the shared `mapChunkWindowRows` |
| `countChunklessPagesWithContent({ sourceId? })` | served |
| `listChunklessPagesWithContent({ sourceId?, batchSize?, afterPageId? })` | served |
| `deleteChunksExcept(slug, keepIds, { sourceId? })` | served |
| `findCodeDefinitions`, `listSymbolTypesForName`, `findCodeRefChunks` | served; a trust or flag scope refuses |
| `codeChunksExist`, `currentCodeChunksExist` | served |
| `listQualifiedSymbolNames(sourceId, symbol, { match, limit })` | served |
| `listSymbolLanguages(sourceId, qualified)` | served (`chunk_queries/walk_reads.rs`); the code walk's language gate: distinct languages of served live pages' chunks that define the name, byte order, any `page_kind` |
| `listSupportedChunkIds(chunkIds, languages)` | served (`walk_reads.rs`); any stored chunk row, in id order, as the SQL reads |
| `listSymbolChunkIds(symbols, { sourceId?, limit })` | served (`walk_reads.rs`); the two-pass walk's near-symbol anchors and unresolved edge targets: any stored chunk row, in id order |
| `readReindexSpendInputs(chunkerVersion, type)` | served (`walk_reads.rs`); see `remediation-records.md` |
| `countOversizedEmbedSkips`, `countOrphanChunks`, `countCodeChunkPages` | served |
| `listWithdrawalChunks`, `deleteChunksForPages` | served |
| `listContextualModeCandidates(sourceIds)` | served |
| `resolveFrozenHits(hits, scope)` | served; a safe-chunk, trust or flag scope refuses |
| `readSegmentRegions(hits)` | served; Rust-only optional member (search dedup's `segmentRegions`) |
| `resolveFrozenHits(hits, scope)` | served |
| `hasUnsealedPages({ sourceId?, sourceIds?, excludePrivate?, types?, excludeSlugPrefixes? })` | served; true when a live page in scope is below the safe-chunk fence (`chunker_version < 4`, or none recorded) |

On `getChunkPage` and `getChunkWindows`, `excludePrivate: true` applies the store page policy (`storePagePolicy`, the
`page_hidden` test of `privatePagesFilterForCaller('p')`), and a safe-chunk read (`requiresSafeChunks`: `requireSafeChunks`,
else `excludePrivate`) applies the chunker-version fence, `chunker_version >= 4`, which a page with no recorded version
fails, as NULL fails the SQL comparison. A page either test drops reads as a page with no chunks in `getChunkPage` and is
absent from the `getChunkWindows` rows. Both reads serve a caller whose record holds only a reader identity and a
private-readable grant (the `callerReaders` opt-in of `storePagePolicy`); any other caller whose policy differs refuses.
`minTrust` and `suppressFlagged` are ignored, because those SQL statements ignore them too.

The code chunk reads, `currentCodeChunksExist` and `resolveFrozenHits` apply the same fence under a safe-chunk read, as
`codeReadFilter` and the frozen-hit SQL do; `codeChunksExist` reads no safe-chunk key, as `pageReadFilter` does not.
The parity case `code reads, code readiness and frozen hits under a safe-chunk scope serve only pages at or above the
chunker-version fence` (test/engine-parity/chunk-reads.test.ts) pins it.

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

A scope that names no source answers no chunks without a store call. A scope of several sources reads the page of
the slug in each, as the SQL engines do: `total_chunks` is the sum of their counts, the range applies to each page
(by position in each page's order when any of them has a segmented chunk, and `max_chunk_index` is then the largest
page's count less one), and the chunks merge in document order with the source id, in byte order, breaking a tie
(`ORDER BY chunkDocumentOrder, p.source_id COLLATE "C"`). `getChunks` over several sources merges the same way.

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
`body_bytes` is the size the page's last flip published, read from the page_body family's body state through `segmented_body_bytes`; parity case: "a published
segmented page with no chunks ..." in `test/engine-parity/segmented-body.test.ts`), has no `quarantine` frontmatter key,
has no chunk rows, and either is not sealed or carries `embed_skip`. A page sealed with no chunks does not count.
`sourceId` scopes the read only when it is a non-empty string, as the SQL truthiness test does.

The list returns `{ id, slug, source_id, compiled_truth, timeline }` in page-id order (a segmented page's NULL body
columns as `""`), after `afterPageId` when it is
given, at most `batchSize` rows (default 50). A negative or fractional `batchSize`, or a fractional
`afterPageId`, is an `invalid_argument`; Postgres rejects a negative `LIMIT` too.

## The site reads (chunk-reads.ts)

These members replace raw SQL at code-def, code-refs, doctor, code readiness, the recursive code walk, withdrawal,
the page projection, repair contextual-mode and evidence delivery. Each answers what its statement in
`chunk-reads.ts` answers.

- The read policy is `pageReadFilter`'s source clause, its page privacy policy (a caller's reader identity and
  private-readable grant included, through the `callerReaders` opt-in of `storePagePolicy`) and its live test: not deleted, no
  `quarantine` frontmatter key, in a source that exists and is not archived. The TypeScript member sends the scope;
  a `requireSafeChunks` scope refuses with `engine_capability_missing` before any store call. `resolveFrozenHits`
  takes `minTrust` and `suppressFlagged` (assemble_evidence passes the caller's floor) and applies `trust::TrustPolicy`
  to the page's stamped tier and its write-gate receipts; the other members refuse them, as no production caller
  passes one. Under `allSources` with no `sourceIds`, the code reads drop `sourceId`, as `codeReadFilter` does. An
  empty `sourceIds` list answers `[]` or `false` without a store call.
- A served page is sealed or carries the activation revision (`servedTextProjectionFilter`).
- `findCodeDefinitions` orders by the definition-type rank (function, class, interface, type, enum, struct, then the
  rest), slug, start line (NULL last), source and chunk id, at most `limit` rows (default 20).
  `findCodeRefChunks` matches `chunk_text ILIKE '%symbol%'` with the symbol unescaped and orders by slug, start line,
  source and chunk id, at most 50 rows by default. `listSymbolTypesForName` answers the distinct types, NULL last,
  at most 20.
- `listQualifiedSymbolNames` reads the served live pages of one source with no `page_kind` test, as the SQL does.
  `exact` matches the qualified or bare name; `contains` matches `ILIKE '%symbol%'`. The names are distinct and in
  byte order: `chunk-reads.ts` adds `ORDER BY symbol_name_qualified` before its `LIMIT`, so every engine cuts the
  same names.
- `countOversizedEmbedSkips(maxBytes)` counts live pages with `embed_skip.reason = 'oversized'` and a body of at most
  `maxBytes` bytes, and how many of them have no chunk row. `countOrphanChunks` counts chunk rows whose page id names
  no page. `countCodeChunkPages` counts the chunks with no symbol name and no language on live `type: code` pages.
- `listWithdrawalChunks` lowers each chunk's text as Postgres `lower()` does and keeps a chunk when every pattern of
  some key for its page (subject `*` or the page slug) matches, by chunk id after the cursor.
- `deleteChunksForPages` removes every chunk of the named pages and seals nothing. `deleteChunksExcept` keeps the
  seal.
- `listContextualModeCandidates` lists live markdown pages of the named sources with no contextual retrieval mode,
  in page-id order, with `sealed` (NULL when there is no projection revision), `embed_skip` and the character count
  of their chunks.
- `resolveFrozenHits` answers one row per hit in scope and per joined chunk, in hit order. A positive chunk id joins
  that chunk, any other id joins chunk index 0, and a page that holds no such chunk gives a row with NULL chunk
  columns. Only a chunk of the live body joins (`chunkGenerationFilter`): a chunk whose occurrence a deferred retire
  closed has no live manifest row, so a hit on it reads no chunk.
- `readSegmentRegions` takes `{ pageId, chunkId }` hits and answers `{ chunk_id, byte_start }` per hit whose chunk is
  visible at its page's live body generation on a segmented page that is sealed or carries the activation projection
  revision, with `byte_start` the stored start of the chunk's live occurrence, in chunk-id order. Each hit names its
  page because the store has no chunk-id index, so the read opens only those pages. The SQL engines do not define the
  member: `segmentRegions` (`src/core/search/dedup.ts`) reads the same rows there through `keywordBoundedRead`, which
  refuses on Rust as raw SQL. Pinned by `test/engine-parity/segment-regions.test.ts`.

## Known differences

- `sealed` is `COALESCE(chunker_version, 0) >= 4`, as in SQL: a page with no recorded version reads `sealed: false`.
  `sealChunks` stamps version 4, even for an empty chunk list. A put that chunks the page (its own raw split of the
  body, or the `chunks` it was given) seals the text projection but does not stamp 4: no sanitizer read those chunks,
  so the page stays below the fence (stamped -1 when it changes the chunks or sits below 4, else left) until a
  `sealChunks` of sanitized chunks. An `upsertChunks`
  that changes a chunk (text, source or modality, a given metadata value, or an added or dropped index) stamps -1,
  and one that repeats the stored chunks leaves the stamp, as `chunkWriteInvalidations` does.
- The store recognizes the activation sentinel revision (`ACTIVATION_SERVED_REVISION`,
  `00000000-0000-0000-0000-000000000153`) as served for the chunk reads; the chunkless reads still require the
  projection and knowledge revisions to match.
