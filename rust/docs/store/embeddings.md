# The brain store: Embeddings

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The vectors of chunks and takes, the embedding signature of each page, and the reads that tell the embed
job what is stale. Code: `rust/crates/gbrain-store/src/embeddings.rs`; TypeScript members:
`src/core/rust-engine/store-members/embeddings.ts`. Chunk writes (`upsertChunks`, `sealChunks`) store the
vector a chunk carries (`chunks.rs`, `replace_chunks_at`).

The store has one vector column, PGLite's `embedding`. An image vector (`embedding_image`) is refused on
write, and a brain whose config names another column (`search_embedding_column`, `embedding_columns`) is
refused by every member that reads the active column.

## Keys

Tag `B` (`keys::EMBEDDING_STATE`); ids are u64 BE, chunk indexes u32 BE.

- `B 'c' <page id> <chunk index>` holds a chunk vector.
- `B 't' <take id>` holds a take vector.
- `B 'g'` holds the vector generation (u64 BE). Every vector write or delete raises it by one in the same
  transaction.
- `B 's' <page id>` holds the page's embedding signature (`pages.embedding_signature`), UTF-8.
- `B 'k' <take id>` holds the take's `claim_rev` at the time its vector was written (u64 BE).

A vector value is: version u8 (1), dims u32 BE, `embedded_at` µs i64 BE, model length u16 BE, the model in
UTF-8, then dims f32 values, little-endian.

## Chunk bookkeeping

The rest of a chunk's embedding state is on the chunk record (`chunks::EmbedState`), so the stale and state
reads never decode a vector:

- `dims`: the width of the stored vector, 0 when there is none.
- `embedded_at_us`: when the vector was written.
- `text_hash`: SHA-256 (lowercase hex) of the chunk text the vector was computed from. PGLite stores
  `md5(chunk_text)`; the store only compares the hash with the current text, so the hash function does not
  show.
- `input_hash`: the caller's `embedding_input_hash`.
- `pending_since_us`: PGLite's `embedding_pending_since`.

The chunk's `model` metadata is the label of its vector.

## Chunk writes

A vector must have the configured width (`embedding_dimensions`, 1536 when unset): "expected N dimensions,
not M" otherwise, and the whole write rolls back. A vector with an empty model label raises "Embedding model
provenance is unknown ...", as PGLite does; the TypeScript `prepareChunks` raises it first when no model is
configured.

`upsertChunks` (merge) follows PGLite's CASE rules. When a chunk's text is unchanged, the old vector stays
unless the write carries a newer one, and the old label stays with it. When the text changed, the old vector
goes. The pending stamp is set on a new chunk with no vector and on changed text, cleared by a new vector,
and otherwise kept. `sealChunks` (replace) writes what it is given.

## Members

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getEmbeddingsByChunkIds(ids)` | `[{ id, embedding }]` for visible chunks of sealed pages with a vector; the member builds the `Map` and checks the column name | `getEmbeddingsByChunkIds` |
| `brain.countStaleChunks(opts)` / `brain.sumStaleChunkChars(opts)` | chunks (or their characters) with no vector, or with a vector on a page whose signature differs from `signature`, on live, non-`embed_skip` pages | `countStaleChunks`, `sumStaleChunkChars` |
| `brain.listStaleChunks(opts)` | one keyset page of stale chunks, by page id and chunk index, or by `updated_desc` with its cursor; 2000 rows by default | `listStaleChunks` |
| `brain.setPageEmbeddingSignature(slug, { sourceId?, signature })` | writes the signature; a missing page is a no-op | `setPageEmbeddingSignature` |
| `brain.invalidateStaleSignatureEmbeddings(opts)` | drops the vectors outside the target space (`currentSpaceChunkPredicate`) on pages whose signature differs; returns how many | `invalidateStaleSignatureEmbeddings` |
| `brain.invalidateContentDriftEmbeddings(opts)` | drops the vectors whose text hash no longer matches the text; returns how many | `invalidateContentDriftEmbeddings` |
| `brain.readEmbeddingStateCounts(opts)` | the state counts in `ops` or `full` mode | `readEmbeddingStateCounts` |
| `brain.listEmbeddingStateRows(opts)` | per-page state rows, ordered by state, source and slug, then limited | `listEmbeddingStateRows` |
| `brain.getChunksWithEmbeddings(slug, opts)` | chunk rows with vectors, in every source unless `sourceId` names one; the member refuses a result that spans two pages | `getChunksWithEmbeddings` |
| `brain.updateTakeEmbeddings(rows)` | stores the vectors of active takes whose claim equals the row's claim; returns how many. The member validates the rows first | `updateTakeEmbeddings` |
| `brain.getTakeEmbeddings(ids)` | `[{ id, embedding }]` for takes with a current vector | `getTakeEmbeddings` |
| `brain.countStaleTakes(opts)` / `brain.listStaleTakes(opts)` | active takes on live pages with no current vector, or one of another model or width; the list is by id, at most 100000 | `countStaleTakes`, `listStaleTakes` |

A take vector counts only while its `B 'k'` row equals the take's `claim_rev`, so a claim edit makes it
stale at once (PGLite compares `embedded_text_hash` with `md5(claim)`). `addTakesBatch` also deletes the
vector when it changes a claim, as Postgres nulls the column; that raises the vector generation, so a warm
vector index (vectors.rs) rebuilds and `searchTakesVector` stops ranking the old claim's vector.

## Known edges

- The page-embedding budget (`budgetLimited`) is not kept: no page leaves the stale queue for it.
- The stale reads (`countStaleChunks`, `sumStaleChunkChars`, `listStaleChunks`), `readEmbeddingStateCounts`,
  `listEmbeddingStateRows` and the `includeUnsealed` reads take PGLite's `chunkGenerationFilter`: an inline chunk only
  on a page that is not segmented, and a segmented chunk only at or below the page's generation with a live manifest
  row. A chunk whose occurrence a deferred retire closed is not read. The served reads (`getEmbeddingsByChunkIds`,
  `cosinesByChunkIds`, sealed `getChunksWithEmbeddings`) keep `chunkVisibleFilter`, the generation alone.
- A segmented page counts as having no chunkless content.
- Segment chunks get no pending stamp.
- `ops` mode counts `embedded` exactly; `unstamped_created_at_min` is null.
