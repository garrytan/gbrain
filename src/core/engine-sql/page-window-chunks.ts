/**
 * The two chunk reads of `get_page` (src/core/ops/get-page-body.ts) that ran through `executeRaw`, as typed members:
 * the chunk a `body: 'window'` read with `around_chunk_id` centers on (`aroundChunk`), and the chunk and embedding
 * counts of a `body: 'none'` read of an unsegmented page (`noneResult`). SQL once for both SQL engines, so the Rust
 * store serves the same members (rust/docs/store/page-window-chunks.md). Each statement keeps the text its caller
 * ran, in both forms of the chunk generation probe: `chunkManifest` is chunkManifestReads (false only for a Postgres
 * role that may not read page_body_manifest and sees no segmented chunk).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The chunk a window centers on: its text and source, and where it sits (a segment occurrence, a projected span). */
export interface WindowChunkRow {
  chunk_text: string;
  chunk_source: string;
  /** The segment occurrence of a segmented page's chunk; null on an inline chunk. Bigint text on Postgres. */
  occurrence_id: number | string | null;
  projected_byte_start: number | string | null;
  projected_byte_end: number | string | null;
}

/** The chunk count of a page at its live generation, and how many of those chunks have a vector. */
export interface PageChunkCounts { total: number; embedded: number }

/**
 * The statements as get-page-body.ts composed them with chunkGenerationProbe('content_chunks', manifest), written out
 * so no SQL is composed here (test/page-window-chunks-sql.test.ts pins each to that composition).
 */
export const PAGE_WINDOW_CHUNKS_SQL = {
  // chunk-visibility-ok: chunkGenerationProbe('content_chunks') written out (pinned by test/page-window-chunks-sql.test.ts)
  windowChunk: "SELECT chunk_text, chunk_source, occurrence_id, projected_byte_start, projected_byte_end FROM content_chunks\n      WHERE id = $1 AND page_id = $2 AND COALESCE(modality, 'text') = 'text' AND EXISTS (SELECT 1 FROM pages gp WHERE gp.id = content_chunks.page_id AND ((content_chunks.body_generation IS NULL AND gp.body_storage <> 'segmented')\n       OR (content_chunks.body_generation <= gp.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = content_chunks.page_id AND lm.occurrence_id = content_chunks.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= gp.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > gp.body_generation)))))",
  // chunk-visibility-ok: chunkGenerationProbe('content_chunks') written out (pinned by test/page-window-chunks-sql.test.ts)
  windowChunkNoManifest: "SELECT chunk_text, chunk_source, occurrence_id, projected_byte_start, projected_byte_end FROM content_chunks\n      WHERE id = $1 AND page_id = $2 AND COALESCE(modality, 'text') = 'text' AND EXISTS (SELECT 1 FROM pages gp WHERE gp.id = content_chunks.page_id AND (content_chunks.body_generation IS NULL AND gp.body_storage <> 'segmented'))",
  // chunk-visibility-ok: chunkGenerationProbe('content_chunks') written out (pinned by test/page-window-chunks-sql.test.ts)
  chunkCounts: "SELECT count(*) AS total, count(*) FILTER (WHERE embedded_at IS NOT NULL) AS embedded FROM content_chunks\n      WHERE page_id = $1 AND EXISTS (SELECT 1 FROM pages gp WHERE gp.id = content_chunks.page_id AND ((content_chunks.body_generation IS NULL AND gp.body_storage <> 'segmented')\n       OR (content_chunks.body_generation <= gp.body_generation\n           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = content_chunks.page_id AND lm.occurrence_id = content_chunks.occurrence_id\n             AND lm.staging_id IS NULL AND lm.gen_from <= gp.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > gp.body_generation)))))",
  // chunk-visibility-ok: chunkGenerationProbe('content_chunks') written out (pinned by test/page-window-chunks-sql.test.ts)
  chunkCountsNoManifest: "SELECT count(*) AS total, count(*) FILTER (WHERE embedded_at IS NOT NULL) AS embedded FROM content_chunks\n      WHERE page_id = $1 AND EXISTS (SELECT 1 FROM pages gp WHERE gp.id = content_chunks.page_id AND (content_chunks.body_generation IS NULL AND gp.body_storage <> 'segmented'))",
} as const;

/** Text chunk `chunkId` of page `pageId` at the page's live generation, or null when it is not one. */
export async function readWindowChunk(tx: Raw, chunkId: number, pageId: number, chunkManifest = true): Promise<WindowChunkRow | null> {
  const [row] = await tx.executeRaw<WindowChunkRow>(
    chunkManifest ? PAGE_WINDOW_CHUNKS_SQL.windowChunk : PAGE_WINDOW_CHUNKS_SQL.windowChunkNoManifest, [chunkId, pageId]);
  return row ?? null;
}

/** The chunks of page `pageId` at its live generation: how many, and how many have a vector (`embedded_at` set). */
export async function countPageChunks(tx: Raw, pageId: number, chunkManifest = true): Promise<PageChunkCounts> {
  const [counts] = await tx.executeRaw<{ total: unknown; embedded: unknown }>(
    chunkManifest ? PAGE_WINDOW_CHUNKS_SQL.chunkCounts : PAGE_WINDOW_CHUNKS_SQL.chunkCountsNoManifest, [pageId]);
  return { total: Number(counts?.total ?? 0), embedded: Number(counts?.embedded ?? 0) };
}
