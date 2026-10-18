/**
 * #6803 part 2: the classes of the projection queue. One SQL fragment shared
 * by `projectionBacklog`, `previewProjectionDrain`, the drain, doctor, search's
 * readiness probe and the `--images` sweep, so the classes partition the queue
 * by construction:
 *
 * - `text`: Markdown, code and segmented pages; the resident drains them.
 * - `archived`: the source is archived; restoring it makes the row drainable.
 * - `protected`: an image whose OCR holds a protected marker; never sealed, by design.
 * - `sealable`: an image the importer attested safe (at or after the safe-chunk
 *   fence, one `image_asset` chunk at index 0 that still holds the page's text)
 *   whose only change since was v153 removing the seal marker
 *   (`gbrain projections drain` restores it: page-state/image-seal.ts).
 * - `reimport`: every other live image; only the importer (fresh OCR, fresh
 *   pixels) can seal it: `gbrain embed --stale --images`.
 */
import { SAFE_FENCE_CHUNKER_VERSION, chunkGenerationFilter, protectedBodyFilter, safeChunksFilter } from '../search/safe-chunks.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { BOUNDED_PREFIX_BYTES } from '../page-window/document.ts';

export type ProjectionClass = 'text' | 'archived' | 'protected' | 'sealable' | 'reimport';

/**
 * The image chunk the importer writes, unchanged: exactly one row, at index 0,
 * holding the page's OCR text or filename. The text is compared through the
 * bounded body prefix; a chunk shorter than the bound that equals it equals
 * the whole body (a longer OCR text is left to the importer: \`reimport\`).
 */
function importerChunkSql(p: string): string {
  return `(SELECT count(*) = 1 AND bool_and(c.chunk_index = 0 AND c.chunk_source = 'image_asset' AND c.modality = 'image'
      AND char_length(c.chunk_text) < ${BOUNDED_PREFIX_BYTES} AND c.chunk_text = COALESCE(NULLIF(${boundedBodyPrefixSql(p)}, ''), ${p}.title))
    FROM content_chunks c WHERE c.page_id = ${p}.id AND ${chunkGenerationFilter(p, 'c')})`;
}

/** A live, unprotected inline image page the importer sealed at or after the safe-chunk fence. Internal aliases only. */
export function sealableImageSql(p: string): string {
  return `(${p}.page_kind = 'image' AND ${p}.body_storage IS DISTINCT FROM 'segmented' AND NOT ${protectedBodyFilter(p)}
    AND ${safeChunksFilter(p)} AND ${importerChunkSql(p)} IS TRUE)`;
}

/**
 * The class of a page's unsealed projection: `p` a live page, `s` its source
 * (internal aliases with every column).
 */
export function projectionClassSql(p: string, s: string): string {
  return `(CASE WHEN ${s}.archived THEN 'archived'
    WHEN ${p}.page_kind IS DISTINCT FROM 'image' OR ${p}.body_storage = 'segmented' THEN 'text'
    WHEN ${protectedBodyFilter(p)} THEN 'protected'
    WHEN ${p}.chunker_version >= ${SAFE_FENCE_CHUNKER_VERSION} AND ${importerChunkSql(p)} IS TRUE THEN 'sealable'
    ELSE 'reimport' END)`;
}
