/**
 * Wave B chunk visibility (spec 4.2).
 *
 * 1. Protects: a segmented page's staged rows (body_generation above the
 *    page's, an unpublished write) and retired rows (an old body whose
 *    deferred retirement has not deleted them yet; the page stays unsealed)
 *    never reach keyword search, vector search, get_chunks, chunk windows or
 *    the embed sweep's stale selection, and generation readers of the
 *    unsealed page see only its live rows; inline pages' rows are unaffected; get_chunks
 *    returns a segmented page in document order (manifest byte_start,
 *    local_ordinal), paging by position.
 * 2. Fails when: a reader drops `chunkVisibleFilter` / `chunkGenerationFilter`
 *    or a segmented page is ordered by its insertion-sequence chunk_index.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage, unitVector, type SegmentedFixture } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'notes/segmented-log';
const RETIRING = 'notes/segmented-retiring';
const LIVE = ['zebrafish opening of the log', 'second live passage', 'later appended passage about herons'];

for (const kind of testBackends()) {
  describe(`segmented chunk visibility (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let fixture: SegmentedFixture;
    let retiring: SegmentedFixture;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.putPage('notes/inline', { type: 'note', title: 'Inline', compiled_truth: 'Inline page about zebrafish care.', timeline: '', frontmatter: {} });
      await installFixtureChunks(engine, 'notes/inline', await prepareMarkdownChunks({ compiled_truth: 'Inline page about zebrafish care.', timeline: '' }));
      // Generation 2 is live. Occurrence 20 (byte 4096) was inserted first, so its
      // rows have lower chunk_index than occurrence 10 (byte 0): insertion order
      // differs from document order.
      fixture = await segmentPage(engine, SLUG, {
        generation: 2,
        occurrences: [
          { id: 20, byteStart: 4096, genFrom: 1, chunks: [{ text: LIVE[2]!, vector: 7, chunkIndex: 0 }] },
          { id: 10, byteStart: 0, genFrom: 1, chunks: [{ text: LIVE[0]!, vector: 7, chunkIndex: 1 }, { text: LIVE[1]!, vector: 7, chunkIndex: 2 }] },
          { id: 40, byteStart: 8192, genFrom: 3, chunks: [{ text: 'staged wombat passage', vector: 9 }, { text: 'staged stale wombat tail' }] },
          { id: 60, byteStart: 12288, genFrom: 2, chunks: [{ text: 'live stale heron tail' }] },
        ],
      });
      // A flip to generation 2 that deferred its retirement: occurrences 30 and 50 are closed, their rows not yet deleted.
      retiring = await segmentPage(engine, RETIRING, {
        generation: 2,
        unsealed: true,
        occurrences: [
          { id: 70, byteStart: 0, genFrom: 1, chunks: [{ text: 'kept passage of the retiring page', vector: 7 }] },
          { id: 30, byteStart: 4096, genFrom: 1, genTo: 2, chunks: [{ text: 'retired quokka passage', vector: 9 }] },
          { id: 50, byteStart: 8192, genFrom: 1, genTo: 2, chunks: [{ text: 'retired stale quokka tail' }] },
          { id: 80, byteStart: 4096, genFrom: 2, chunks: [{ text: 'new passage of the retiring page', vector: 7 }] },
        ],
      });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const liveIds = () => [...LIVE, 'live stale heron tail'].map(t => fixture.chunkIds.get(t)!);
    const hiddenIds = () => [...['staged wombat passage', 'staged stale wombat tail'].map(t => fixture.chunkIds.get(t)!),
      ...['retired quokka passage', 'retired stale quokka tail'].map(t => retiring.chunkIds.get(t)!)];

    test('keyword search sees live rows only', async () => {
      expect((await engine.searchKeyword('zebrafish')).map(r => r.slug).sort()).toEqual(['notes/inline', SLUG]);
      expect(await engine.searchKeyword('quokka')).toEqual([]);
      expect(await engine.searchKeyword('wombat')).toEqual([]);
    });

    test('vector search sees live rows only', async () => {
      const live = await engine.searchVector(Float32Array.from(await unitVector(engine, 7)), { limit: 20 });
      expect(live.filter(r => r.slug === SLUG).map(r => Number(r.chunk_id)).every(id => liveIds().includes(id))).toBe(true);
      expect(live.some(r => r.slug === SLUG)).toBe(true);
      // Only the staged and retired rows carry this vector exactly.
      const hidden = await engine.searchVector(Float32Array.from(await unitVector(engine, 9)), { limit: 20 });
      for (const id of hidden.map(r => Number(r.chunk_id))) expect(hiddenIds()).not.toContain(id);
    });

    test('get_chunks returns live rows in document order and pages by position', async () => {
      const chunks = await engine.getChunks(SLUG);
      expect(chunks.map(c => c.chunk_text)).toEqual([LIVE[0], LIVE[1], LIVE[2], 'live stale heron tail']);
      const first = await engine.getChunkPage(SLUG, { fromIndex: 0, limit: 2 });
      expect(first.chunks.map(c => c.chunk_text)).toEqual([LIVE[0], LIVE[1]]);
      expect(first.total_chunks).toBe(4);
      expect(first.max_chunk_index).toBe(3);
      const second = await engine.getChunkPage(SLUG, { fromIndex: 2, limit: 2 });
      expect(second.chunks.map(c => c.chunk_text)).toEqual([LIVE[2], 'live stale heron tail']);
    });

    test('inline pages keep chunk_index order and every row', async () => {
      const chunks = await engine.getChunks('notes/inline');
      expect(chunks.map(c => c.chunk_index)).toEqual(chunks.map((_, i) => i));
      expect(chunks.length).toBeGreaterThan(0);
    });

    test('chunk windows read live rows only', async () => {
      const [page] = await engine.getChunkWindows([{ page_id: fixture.pageId, from_index: 0, to_index: 1000, priority: 0 }],
        { chunkSources: ['compiled_truth'], maxRows: 100 });
      const ids = page!.chunks.map(c => c.id);
      expect(ids.sort()).toEqual(liveIds().sort());
      expect(page!.max_chunk_index).toBe(Math.max(...(await engine.getChunks(SLUG)).map(c => c.chunk_index)));
    });

    test("the embed sweep's stale selection skips staged and retired rows", async () => {
      const stale = await engine.listStaleChunks({ batchSize: 100 });
      const texts = stale.filter(r => r.slug === SLUG).map(r => r.chunk_text);
      expect(texts).toEqual(['live stale heron tail']);
      expect(stale.filter(r => r.slug === RETIRING)).toEqual([]);
    });

    test('generation readers of a page awaiting its deferred retirement see its live rows only', async () => {
      expect((await engine.getChunks(RETIRING, { includeUnsealed: true })).map(c => c.chunk_text))
        .toEqual(['kept passage of the retiring page', 'new passage of the retiring page']);
      expect(await engine.getChunks(RETIRING)).toEqual([]);
    });
  });
}
