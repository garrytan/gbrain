/**
 * Wave B segment vector reuse (spec 4.4).
 *
 * 1. Protects: `reuseSegmentChunkVectors` reads only the live rows of the
 *    occurrences a write retires (one statement, never the whole page or
 *    `getChunks`), copies an admitted vector onto the new chunk with the same
 *    source and text, so an unchanged chunk inside a rewritten tail keeps its
 *    vector, and gives new text, text found only outside the retired
 *    occurrences, staged rows' text and vectors recorded for another tier none.
 * 2. Fails when: reuse widens to every chunk of the page, ignores the
 *    generation, or skips the input-hash gate.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { reuseSegmentChunkVectors } from '../../src/core/import-chunk-reuse.ts';
import { embeddingInputHash } from '../../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';
import type { SegmentChunkInput } from '../../src/core/page-body/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage, unitVector } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'notes/segmented-reuse';
const TITLE = 'Segmented reuse';

const chunk = (text: string, ordinal: number): SegmentChunkInput => ({ chunk_text: text, chunk_source: 'compiled_truth', occurrence_id: 99,
  local_ordinal: ordinal, raw_byte_start: 0, raw_byte_end: text.length });

for (const kind of testBackends()) {
  describe(`segment vector reuse (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let pageId: number;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      ({ pageId } = await segmentPage(engine, SLUG, {
        generation: 2,
        title: TITLE,
        occurrences: [
          { id: 10, byteStart: 0, genFrom: 1, chunks: [{ text: 'only in a live occurrence', vector: 1 }] },
          { id: 20, byteStart: 4096, genFrom: 1, chunks: [{ text: 'unchanged tail chunk', vector: 2 }, { text: 'edited tail chunk', vector: 3 },
            { text: 'other tier chunk', vector: 4 }, { text: 'staged chunk text', vector: 5, generation: 3 }] },
        ],
      }));
      const provenance = embeddingInputContext(await embeddingWriteTarget(engine), TITLE, null, []);
      for (const text of ['only in a live occurrence', 'unchanged tail chunk', 'edited tail chunk', 'staged chunk text']) {
        await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash = $3 WHERE page_id = $1 AND chunk_text = $2',
          [pageId, text, embeddingInputHash(provenance, 'title', { chunk_text: text, chunk_source: 'compiled_truth' })]);
      }
      await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash = $3 WHERE page_id = $1 AND chunk_text = $2',
        [pageId, 'other tier chunk', embeddingInputHash(provenance, 'none', { chunk_text: 'other tier chunk', chunk_source: 'compiled_truth' })]);
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('only the retired occurrences rows are read, and only matching text keeps its vector', async () => {
      const chunks = ['unchanged tail chunk', 'brand new chunk', 'only in a live occurrence', 'staged chunk text', 'other tier chunk'].map(chunk);
      const exec = spyOn(engine, 'executeRaw');
      const getChunks = spyOn(engine, 'getChunks');
      let reused: number;
      try {
        reused = await reuseSegmentChunkVectors(engine, { pageId, retiredOccurrences: [20], chunks, title: TITLE, corpusGeneration: null, tier: 'title' });
        const reads = exec.mock.calls.map(([sql]) => String(sql)).filter(sql => /content_chunks/.test(sql));
        expect(reads).toHaveLength(1);
        expect(reads[0]).toContain('occurrence_id = ANY');
        expect(getChunks).not.toHaveBeenCalled();
      } finally { exec.mockRestore(); getChunks.mockRestore(); }
      expect(reused).toBe(1);
      expect(Array.from(chunks[0]!.embedding!)).toEqual(await unitVector(engine, 2));
      expect(chunks[0]!.embedding_input_hash).toEqual(expect.any(String));
      for (const i of [1, 2, 3, 4]) expect(chunks[i]!.embedding).toBeUndefined();
    });

    test('no retired occurrences reads nothing', async () => {
      const exec = spyOn(engine, 'executeRaw');
      try {
        expect(await reuseSegmentChunkVectors(engine, { pageId, retiredOccurrences: [], chunks: [chunk('unchanged tail chunk', 0)], title: TITLE, corpusGeneration: null, tier: 'title' })).toBe(0);
        expect(exec).not.toHaveBeenCalled();
      } finally { exec.mockRestore(); }
    });
  });
}
