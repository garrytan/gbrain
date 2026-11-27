# The brain store: embed --stale reads and writes

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the reads and writes `gbrain embed --stale` (`runEmbedCore({ stale: true })`, which the doctor's `embed.stale`
remediation runs) makes besides the stale-chunk family of [embeddings.md](embeddings.md). PGLite and Postgres run the same
SQL as before (`src/core/engine-sql/embed-stale-work.ts`, with the active embedding column spliced as a quoted identifier). The
TypeScript side is `src/core/rust-engine/store-members/embed-stale-work.ts`; the store side is
`rust/crates/gbrain-store/src/embeddings/stale_work.rs` and `Store::ensure_config` in `config.rs`. The provenance stamp's read,
`readPageProvenanceComplete`, is the embeddings family's member (`embeddings.rs`; SQL in
`src/core/engine-sql/embedding-provenance.ts`).

## Served from the store

| JS | Reads or writes |
| --- | --- |
| `brain.countArchivedEmbeddingWork({ sourceId, signature, includeNullSignature, includeUnsealed, column })` | live, non-`embed_skip` pages of archived sources with embedding work: unsealed (with `includeUnsealed`), a chunk with no vector, a vector of other text or another signature, or text and no chunk on a page that is not quarantined; a null `column` reads every chunk as missing its vector |
| `brain.countEmbedPendingProjections(scope)` | live, non-`embed_skip`, unsealed pages of the scope (`sourceId`, `activeSourcesOnly`, `existingChunksOnly`, and with `stale` a segmented body or a chunk with embedding work) |
| `brain.listEmbedPendingProjections(scope, limit)` | the first `limit` of them in active sources, by page id: `{ source_id, slug, page_kind }` |
| `brain.listEmbedProjectionRepairPages(scope, afterPageId, limit)` | the next `limit` of them in active sources after `afterPageId` that are markdown, code or segmented: `{ slug, source_id, id }` |
| `brain.listUnembeddedChunkIndexes(slug, sourceId)` | the chunk indexes of the page's live body (`chunkGenerationFilter`) with no vector, ascending; `embedStaleForSource`, the embed-backfill job, reads it |
| `brain.sumEmbedBackfillChars(sourceId, all)` | `{ chunk_chars, chunkless_chars }`: the characters of live pages' chunks (only those with no vector unless `all`) and, unless `all`, of live pages with no chunk record (`length(compiled_truth) + length(timeline)`, skipped when either is NULL); `sourceId` narrows both; the embed backfill cost estimate (`embed-consent.ts`) reads it |
| `brain.readPageIsSegmented(pageId)` | whether the page keeps its body in segments |
| `brain.hasEmbeddingSignatureDrift({ column, signature, sourceId, includeNullSignature, nullSignatureOnly })` | whether a live, non-`embed_skip`, not budget-limited page of a live source with a live-body chunk that has a vector carries a signature the rule names |
| `brain.ensureConfig(key, initial)` | `lockContentDriftState`: stores `initial` when the key has no value and returns the stored value |
| `brain.invalidateContentDriftChunks({ column, afterChunkId, limit, sourceId })` | examines the next `limit` chunk records after `afterChunkId` in id order and drops the vector of each whose text changed since it was embedded, on a live, non-`embed_skip`, not budget-limited page of a live source: `{ last_id, checked, drifted }` |

Text and NULL rules: `md5(chunk_text)` is the store's text hash (sha256 of the text, compared the same way), a comparison
with a NULL side is false, the archived-work and pending reads look at every chunk record of a page (the SQL reads
`content_chunks` with no generation filter), and the drift probe reads live-body chunks (`chunkGenerationFilter`).
"Budget-limited" is `pageBudgetLimitedFilter`: a held or capped row that still applies (the page is large, or the reason is
`archive_backfill`, `archive_open_day` or `call_import`). The store keeps that row in the page's ledger
record (`page_embedding_budget.rs`).

Differences from the SQL a caller can see on a Rust brain:

- The store keeps one vector column, `embedding`. A member asked about another column refuses `engine_capability_missing`
  in TypeScript before the store call.
- Chunk ids differ from the SQL engines' ids, so a content-drift cursor is meaningful only on the brain that wrote it.
- `lockContentDriftState` takes no row lock: the store has one writer, so the write is the lock.

## The width-mismatch recipe

`gbrain embed` refuses a width mismatch before any work, with `EmbeddingDimMismatchError` and the recipe of
`embeddingMismatchMessage` (`src/core/embedding-dim-check.ts`). On a Rust brain the recipe keeps the header and the two
width lines and names no command, because the store fixes the vector width when the brain is created and no command changes
it yet (loss "no vector-width change on Rust" in `docs/designs/RUST_ENGINE.md`).

`test/engine-parity/embed-stale-work.test.ts` runs the members, `embed --stale` and the doctor's embed remediation on PGLite,
Postgres and Rust and compares them; `test/embedding-mismatch-rust-recipe.test.ts` pins the recipes.
