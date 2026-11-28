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
- `B 'b' <page id>` holds the page's embedding ledger row (`page_embedding_budget`), JSON. It goes with the
  page when the page is deleted for good.

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

`upsertChunks` serves `opts.embeddingColumn`, the write column import resolves (`stampEmbeddingInputs`) and the
reindex paths pass. The store keeps one vector column, so the option is served when it names `embedding` of type
`vector`; PGLite writes that column too. The descriptor's `dimensions` is not read: PGLite's `::vector` cast never
reads it, and the default descriptor carries a 1536 placeholder on a brain of any width. The width check on each
vector above still refuses a vector of another width. A column with a model labels each chunk that names none, as
PGLite's `writeCol.embeddingModel || ...` does. Any other column (`embedding_image`, a registry column, `halfvec`)
refuses `engine_capability_missing` and writes nothing. Config that routes writes to another column
(`search_embedding_column`, `embedding_columns`) still refuses in `prepareChunks`.

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


## Page embedding ledger

The paid path meters each page's embedding spend on one ledger row (`gbrain_store::page_embedding_budget`;
the policy is `src/core/page-embedding-budget.ts`, the SQL copy `src/core/engine-sql/page-embedding-budget.ts`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readPageEmbeddingBudget(pageId)` | the hold marker (`transcript_archive.embedding_hold`, else `call_import.embedding_hold`) and the row's state, reason, signature, spent, reserved, cap, unpriced count and reservation window; all null for a missing page | the plan's hold read |
| `brain.recordPageEmbeddingHold(pageId, reason)` | a held row for a page with no row; a page with a row keeps it | `INSERT ... ON CONFLICT DO NOTHING` |
| `brain.holdPageEmbedding(pageId, reason)` | the row is `held` with `reason`: added when the page has none, a held row's reason replaced, an open row re-held; the spend columns are kept. An unknown page refuses `page_not_found`, a reason with a NUL byte `invalid_argument` | `INSERT ... ON CONFLICT (page_id) DO UPDATE SET state = 'held', reason = EXCLUDED.reason` |
| `brain.openPageEmbeddingHold(pageId)` | opens the row; no row is a no-op | the small-page approval |
| `brain.reservePageEmbedding(pageId, input)` | `held`, `needs_junk` (an open, unapproved page with no junk verdict yet) or a `grant` of the newest chunks that fit the cap | the grant transaction |
| `brain.settlePageEmbeddingReservation(pageId, settle)` | books the spend and drops the hold, only while the grant's window is still open | `settleLedgerReservation` |

The grant is one store write, so it needs no row lock. A reservation older than an hour counts as spent.
A new signature starts a new ledger. A window is `reserved_at` in microseconds; a new window is at least one
millisecond later than the one it replaces. An unlimited cap crosses the addon as `null`.

Spent and reserved amounts keep every f64, as PGLite's DOUBLE PRECISION does: a settle can book Infinity or
NaN (and -Infinity books 0, the caller's `Math.max(0, bookedUsd)`). The record stores each amount as its IEEE 754
bits in hex (`"0x7ff0000000000000"`) and still reads a record holding plain numbers; across the addon a non-finite
amount is its JavaScript name (`"Infinity"`, `"-Infinity"`, `"NaN"`). Tests: `rust/crates/gbrain-store/tests/page_embedding_budget.rs`
and the non-finite case in `test/engine-parity/page-embedding-budget.test.ts`.

A take vector counts only while its `B 'k'` row equals the take's `claim_rev`, so a claim edit makes it
stale at once (PGLite compares `embedded_text_hash` with `md5(claim)`). `addTakesBatch` also deletes the
vector when it changes a claim, as Postgres nulls the column; that raises the vector generation, so a warm
vector index (vectors.rs) rebuilds and `searchTakesVector` stops ranking the old claim's vector. Test: `a_take_vector_is_current_only_at_the_claim_revision` in
`rust/crates/gbrain-store/tests/embedding_catalog.rs`.


## Embedding install

The embedding effect installs a page's vectors through four members (`gbrain_store::embedding_install`;
the SQL copy is `src/core/engine-sql/embedding-install.ts`, the callers `src/core/persistence/effects.ts`
and `src/core/page-state/projections.ts`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readEmbeddingCompletion(pageId, { signature, model })` | one row per visible chunk: `{ id, chunk_text, chunk_source, embedding_input_hash, embedded, stamped }`. `embedded` is a vector computed from the current text under `model`; `stamped` is the page's signature equal to `signature` | the completion read |
| `brain.lockEffectClaimRow(effectId)` | the effect's `{ state, execution_token }`, or null when no effect has the id | `SELECT ... FOR UPDATE` on `persistence_effects` |
| `lockEmbeddingSwitch()` | nothing: the store write that installs is exclusive, so the switch cannot flip inside it | `SELECT ... FOR SHARE` on the `embedding_disabled` config row |
| `brain.installChunkEmbeddings(pageId, rows)` | stores each row's vector on the page's chunk with that id while the chunk still holds the row's text; any other row is skipped. A row with no model keeps the chunk's old one | the batch `UPDATE ... FROM jsonb_to_recordset` |

The store has one vector column, `embedding`, of 32-bit floats, and no image vectors. The members refuse another column, an
image row and a row with no vector, so a vector never lands in the wrong space. `installChunkEmbeddings` also
refuses (`engine_capability_missing`, before any write) a `halfvec` descriptor (Postgres rounds to half precision; the
store keeps float32) and any row whose vector length differs from the width the store keeps (`readChunkVectorColumn`:
the first stored vector, else the config `embedding_dimensions`); with no width known yet, a batch whose rows differ in
length from each other. The descriptor's `dimensions` is not compared (see Known edges). A refused batch writes nothing,
so no chunk is ever marked complete from a short vector. The store keeps a sha256
text hash where PGLite keeps md5; both answer "the text has not changed since the vector was computed".
`readEmbeddingCompletion` receives only the column's name, so it checks the name alone; it writes nothing.

## Vector catalog

`embedding_catalog.rs` answers what the embedding commands ask Postgres's catalog (TS
`engine-sql/embedding-catalog.ts`). The store has no column types, so:

| Brain method | Returns | Members |
|---|---|---|
| `brain.readChunkVectorColumn({ name })` | `{ exists, dims }` for `embedding`: the width of the first stored chunk vector, else the config `embedding_dimensions`; with neither, `{ exists: false, dims: null }`. `embedding_image` and `embedding_multimodal`: always `{ exists: true, dims: 1024 }`. Any other column: `{ exists: false, dims: null }` | `readChunkVectorColumn` |
| `brain.readEmbeddingIdentity()` | `{ model, dimensions }` with the same width; the model is the first chunk vector's, else the config `embedding_model`; null with no width | `readEmbeddingIdentity` |
| `brain.hasStoredVectors({ name })` | whether `content_chunks`, `facts` or `takes` holds a vector (a take's only at its current claim revision); `query_cache` is always false | `hasStoredVectors` |

`listEmbeddingStores` is answered in TS (every table of `PRIMARY_EMBEDDING_TABLES`).
`readChunkColumnTypes` (doctor embedding_column_registry) is answered in TS from `readChunkVectorColumn`: each
column that exists reads as `vector(<dims>)`, because the store keeps no `halfvec`. `countChunkColumnCoverage` is
answered from `getStats` (every chunk, soft-deleted pages too): `embedding` covers the chunks with a stored vector, a
fixed column covers none, and any other column fails with Postgres's `column "<name>" does not exist`.
`embedding_image` and `embedding_multimodal` are declared `vector(1024)` on every Postgres and PGLite brain
(`src/schema.sql`, `engine-sql/bootstrap.ts`, migration v078) and no migration changes their width, so the
store reports them present at 1024, as PGLite does. The store keeps no vector for them: a chunk image vector
is still refused on write.

## Known edges

- The stale queue keeps a held or capped page (`budgetLimited` is not kept). The plan then refuses the page
  from its ledger row, so no money is spent on it, but each embedding run lists it again.
- `reservePageSpend`'s embedding branch, `listBudgetLimitedPages` and `readPageSizeStates` are still raw SQL,
  so a Rust brain refuses them (`engine_capability_missing`). `holdPageEmbedding` and `readPageSizeRows` are
  served from the ledger row.
- The stale reads (`countStaleChunks`, `sumStaleChunkChars`, `listStaleChunks`), `readEmbeddingStateCounts`,
  `listEmbeddingStateRows` and the `includeUnsealed` reads take PGLite's `chunkGenerationFilter`: an inline chunk only
  on a page that is not segmented, and a segmented chunk only at or below the page's generation with a live manifest
  row. A chunk whose occurrence a deferred retire closed is not read. The served reads (`getEmbeddingsByChunkIds`,
  `cosinesByChunkIds`, sealed `getChunksWithEmbeddings`) keep `chunkVisibleFilter`, the generation alone (`visible_at`).
- A segmented page counts as having no chunkless content.
- Segment chunks get no pending stamp.
- `ops` mode counts `embedded` exactly; `unstamped_created_at_min` is null.
- `moveDisplacedChunksAndPrune` (PGLite's re-index of displaced chunks) is not done.
- The default `embedding` descriptor carries the placeholder `dimensions: 1536` on every brain (`normalizeEngineColumn`:
  the SQL engines cast with a bare `::vector`, which never reads it), so `installChunkEmbeddings` does not compare the
  descriptor's `dimensions`; the store's own width is the check. On a brain with no stored vector and no
  `embedding_dimensions`, the first batch fixes the width, so a first batch of the wrong width installs consistently.
- The install path's zero-norm chunk update (`page-state/projections.ts`) is still raw SQL, so a Rust brain
  refuses a page with a zero-norm vector (`engine_capability_missing`).
