/**
 * The segmented chunker's version stamp, in a module with no imports. engine-sql/page-body.ts (reached from
 * postgres-engine.ts) imports it from here: segment-chunks.ts statically reaches the tree-sitter WASM assets, which
 * Node cannot load, and OpenClaw loads the engine under Node.
 */

/**
 * `pages.chunker_version` of a sealed segmented page whose live chunks were all made by this chunker. Segments are
 * chunked by the markdown pipeline (chunkProjectedText, fencedCodeChunks) under the same safe-fence contract, so it
 * stays at or above SAFE_FENCE_CHUNKER_VERSION, but it is its own identity: inline pages keep MARKDOWN_CHUNKER_VERSION.
 *
 * 5: the hard cap's forced cuts land on a sentence or line end (chunkProjectedText `boundaryCuts`), so a sentence the
 * cap used to split now sits whole in one chunk; and a timeline segment with bullet lines breaks only at bullet starts
 * chosen by the bullet itself (chunkers/bullet-chunks.ts), so an entry added at the top changes only the passage it joins.
 * Pages sealed at 4 keep serving their chunks until
 * `gbrain reindex --segmented --apply` re-chunks them (page-body/rechunk.ts). A change to the cuts or the stored
 * per-segment metadata bumps SEGMENTER_VERSION instead.
 */
export const SEGMENTED_CHUNKER_VERSION = 5;
