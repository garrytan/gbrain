/**
 * Pins the statements of engine-sql/page-window-chunks.ts to the text get-page-body.ts composed: each is
 * chunkGenerationProbe('content_chunks', manifest) spliced into its caller's statement, in both forms of the probe.
 */
import { expect, test } from 'bun:test';
import { PAGE_WINDOW_CHUNKS_SQL } from '../src/core/engine-sql/page-window-chunks.ts';
import { chunkGenerationProbe } from '../src/core/search/safe-chunks.ts';

const windowChunk = (manifest: boolean) =>
  `SELECT chunk_text, chunk_source, occurrence_id, projected_byte_start, projected_byte_end FROM content_chunks
      WHERE id = $1 AND page_id = $2 AND COALESCE(modality, 'text') = 'text' AND ${chunkGenerationProbe('content_chunks', manifest)}`;
const chunkCounts = (manifest: boolean) =>
  `SELECT count(*) AS total, count(*) FILTER (WHERE embedded_at IS NOT NULL) AS embedded FROM content_chunks
      WHERE page_id = $1 AND ${chunkGenerationProbe('content_chunks', manifest)}`;

test('the get_page chunk statements are the caller\'s text in both forms of the generation probe', () => {
  expect({ ...PAGE_WINDOW_CHUNKS_SQL } as Record<string, string>).toEqual({
    windowChunk: windowChunk(true), windowChunkNoManifest: windowChunk(false),
    chunkCounts: chunkCounts(true), chunkCountsNoManifest: chunkCounts(false),
  });
});
