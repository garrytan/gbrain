/**
 * Wave B segmented embedding (spec 4.4).
 *
 * 1. Protects: a segmented page is embedded from its vector-less live rows
 *    alone (chunk text, title, plain tier): never a segment or body read,
 *    never a staged or retired row; an append's effect (`occurrenceIds`)
 *    embeds only the new occurrences' rows; `embedStalePages` routes a
 *    segmented page here; each installed vector records its input hash; the
 *    per-page budget meters a large segmented page by body_bytes and its junk
 *    check samples windows from segments.
 * 2. Fails when: the sweep reads the body or every chunk of a segmented page,
 *    embeds rows outside the live generation, or widens an append's effect.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { embedStalePages } from '../../src/core/embed-stale.ts';
import { embeddingInputHash, plainEmbeddingTier } from '../../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';
import { embedSegmentedPage, readSegmentedEmbedPage } from '../../src/core/page-body/segmented-embedding.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage, unitVector } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'notes/segmented-embed';
const TITLE = 'Segmented embed';

for (const kind of testBackends()) {
  describe(`segmented embedding (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let embedded: string[][];
    const embedFn = async (texts: string[]) => {
      embedded.push(texts);
      const v = Float32Array.from(await unitVector(engine, 3));
      return texts.map(() => v);
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      embedded = [];
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw('DELETE FROM page_segment_texts');
      await engine.executeRaw('DELETE FROM page_embedding_budget');
      await segmentPage(engine, SLUG, {
        generation: 2,
        title: TITLE,
        occurrences: [
          { id: 10, byteStart: 0, genFrom: 1, chunks: [{ text: 'first live row' }, { text: 'second live row' }] },
          { id: 20, byteStart: 4096, genFrom: 2, chunks: [{ text: 'appended row' }] },
          { id: 30, byteStart: 4096, genFrom: 1, genTo: 2, chunks: [{ text: 'retired row' }] },
          { id: 40, byteStart: 8192, genFrom: 3, chunks: [{ text: 'staged row' }] },
        ],
      });
    });

    const vectored = async () => (await engine.executeRaw<{ chunk_text: string }>(
      `SELECT cc.chunk_text FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1 AND cc.embedding IS NOT NULL ORDER BY cc.chunk_text`, [SLUG])).map(r => r.chunk_text);

    test('an append effect embeds only its occurrences, the sweep the rest of the live rows, never a segment or the body', async () => {
      const page = (await readSegmentedEmbedPage(engine, { sourceId: 'default', slug: SLUG }))!;
      expect(page).toMatchObject({ slug: SLUG, title: TITLE, body_storage: 'segmented' });
      const exec = spyOn(engine, 'executeRaw');
      try {
        expect(await embedSegmentedPage(engine, page, { embedFn, occurrenceIds: [20] })).toEqual({ embedded: 1, complete: true });
        expect(await vectored()).toEqual(['appended row']);
        expect(await embedSegmentedPage(engine, page, { embedFn, batchRows: 1 })).toEqual({ embedded: 2, complete: true });
        for (const [sql] of exec.mock.calls) expect(String(sql)).not.toMatch(/page_segment_texts|compiled_truth|timeline_lead|truth_lead/);
      } finally { exec.mockRestore(); }
      expect(await vectored()).toEqual(['appended row', 'first live row', 'second live row']);
      expect(embedded.flat().some(t => /retired row|staged row/.test(t))).toBe(false);
      const provenance = embeddingInputContext(await embeddingWriteTarget(engine), TITLE, null, []);
      const [row] = await engine.executeRaw<{ embedding_input_hash: string }>(
        `SELECT embedding_input_hash FROM content_chunks WHERE chunk_text = 'appended row'`);
      expect(row!.embedding_input_hash).toBe(embeddingInputHash(provenance, plainEmbeddingTier(null), { chunk_text: 'appended row', chunk_source: 'compiled_truth' }));
    });

    test('embedStalePages routes a segmented page to the keyset sweep', async () => {
      const result = await embedStalePages(engine, [SLUG], 'default', { embedFn });
      expect(result.embedded).toBe(3);
      expect(await vectored()).toEqual(['appended row', 'first live row', 'second live row']);
    });

    test('the per-page budget meters a large segmented page by body_bytes and samples junk from its segments', async () => {
      const markup = '<div class="x"><span data-a="1"></span></div>'.repeat(2000);
      await segmentPage(engine, 'notes/segmented-junk', { generation: 1, bodyBytes: 4 * 1024 * 1024,
        occurrences: [{ id: 1, byteStart: 0, genFrom: 1, chunks: [{ text: markup }] }] });
      const junk = (await readSegmentedEmbedPage(engine, { sourceId: 'default', slug: 'notes/segmented-junk' }))!;
      expect(await embedSegmentedPage(engine, junk, { embedFn })).toEqual({ embedded: 0, complete: false, stopped: 'budget' });
      const [held] = await engine.executeRaw<{ state: string }>('SELECT state FROM page_embedding_budget WHERE page_id = $1', [junk.id]);
      expect(held!.state).toBe('held');
      const prose = 'An ordinary paragraph about herons wading in the marsh at dawn. '.repeat(200);
      await segmentPage(engine, 'notes/segmented-prose', { generation: 1, bodyBytes: 4 * 1024 * 1024,
        occurrences: [{ id: 1, byteStart: 0, genFrom: 1, chunks: [{ text: prose }] }] });
      const page = (await readSegmentedEmbedPage(engine, { sourceId: 'default', slug: 'notes/segmented-prose' }))!;
      expect(await embedSegmentedPage(engine, page, { embedFn })).toEqual({ embedded: 1, complete: true });
    });

    test('an inline page is not a segmented embed page', async () => {
      await engine.putPage('notes/inline-embed', { type: 'note', title: 'Inline', compiled_truth: 'Inline body.', timeline: '', frontmatter: {} });
      expect(await readSegmentedEmbedPage(engine, { sourceId: 'default', slug: 'notes/inline-embed' })).toBeNull();
    });
  });
}
