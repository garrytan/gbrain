/**
 * Wave B PR 2: what a sealed segmented page (imported for real, sealed by
 * sealSegmentedPage) gives search.
 *
 * 1. Protects: the seal stamps a chunker_version at or above
 *    SAFE_FENCE_CHUNKER_VERSION (its chunks are built under the same
 *    safe-fence contract), so chunk windows and remote (requireSafeChunks)
 *    keyword search serve the page; and the seal indexes the timeline lead
 *    after the page's withdrawal overlay, so a row withdrawn for every
 *    subject ('*') after the import is not findable once the projection is
 *    rebuilt (withdrawal.ts bumps the revision and deletes the chunk rows;
 *    the rebuild rechunks from the overlaid text and reseals).
 * 2. Fails when: SEGMENTED_CHUNKER_VERSION drops below the safe-fence
 *    version (remote search and chunk windows withhold the page) or back to
 *    the inline chunker's version (it names its own forced cuts since Wave B
 *    PR 4), or the seal indexes the raw lead (the withdrawn token is findable).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../src/core/search/safe-chunks.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../../src/core/chunkers/recursive.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { factRow, importSegmented, pageContent, privacyText } from '../helpers/segmented-privacy-fixture.ts';

let engine: BrainEngine;

const pageRow = async (pageId: number) => (await engine.executeRaw<{ chunker_version: number; sealed: boolean }>(
  'SELECT chunker_version, text_projection_revision = knowledge_revision AS sealed FROM pages WHERE id=$1', [pageId]))[0]!;

for (const kind of testBackends()) {
  describe(`a sealed segmented page (${kind})`, () => {
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);

    afterAll(async () => { await close(); });

    beforeEach(async () => {
      for (const table of ['pages', 'fact_withdrawals']) await engine.executeRaw(`DELETE FROM ${table}`);
    });

    test('carries the safe-fence chunker version, so chunk windows and remote keyword search serve it', async () => {
      const r = mulberry32(211);
      const truth = `${privacyText(r, 600_000)}\nzzsealedneedle appears once in the truth\n${privacyText(r, 900_000)}`;
      const pageId = await importSegmented(engine, 'notes/sealed', pageContent(truth));
      const page = await pageRow(pageId);
      const [win] = await engine.getChunkWindows([{ page_id: pageId, from_index: 0, to_index: 10, priority: 0 }], { chunkSources: ['compiled_truth'], maxRows: 50 });
      expect(win!.chunks.length).toBeGreaterThan(0);
      const remote = await engine.searchKeyword('zzsealedneedle', { requireSafeChunks: true });
      expect(remote.map(h => h.slug)).toContain('notes/sealed');
      expect(remote.find(h => h.slug === 'notes/sealed')!.chunk_text).toContain('zzsealedneedle');
      expect(page).toEqual({ chunker_version: SEGMENTED_CHUNKER_VERSION, sealed: true });
      expect(SEGMENTED_CHUNKER_VERSION).toBeGreaterThan(MARKDOWN_CHUNKER_VERSION);
      expect(SEGMENTED_CHUNKER_VERSION).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
    }, 240_000);

    test("a reseal indexes the timeline lead after the withdrawal overlay: a row withdrawn for '*' after the import is not findable", async () => {
      const r = mulberry32(223);
      const withdrawn = factRow('zzleadwithdrawn former role');
      const kept = factRow('zzleadkept current role');
      const timeline = `${renderFactsTable([withdrawn, kept])}\n${privacyText(r, 200_000)}`;
      const pageId = await importSegmented(engine, 'notes/lead', pageContent(privacyText(r, 1_400_000), timeline));
      const vectorHas = async (word: string) => (await engine.executeRaw<{ hit: boolean }>(
        "SELECT search_vector @@ plainto_tsquery('english', $2) AS hit FROM pages WHERE id=$1", [pageId, word]))[0]!.hit;
      expect(await vectorHas('zzleadwithdrawn')).toBe(true);
      await engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash)
        VALUES ('default', 'world', '*', gbrain_fact_fingerprint($1))`, [withdrawn.claim]);
      await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid(), text_projection_revision=NULL WHERE id=$1', [pageId]);
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1', [pageId]);
      expect((await buildSegmentedProjection(engine, { sourceId: 'default', slug: 'notes/lead' })).sealed).toBe(true);
      const [lead] = await engine.executeRaw<{ timeline_lead: string }>('SELECT timeline_lead FROM pages WHERE id=$1', [pageId]);
      expect(lead!.timeline_lead).toContain('zzleadwithdrawn');
      expect((await pageRow(pageId)).sealed).toBe(true);
      expect(await vectorHas('zzleadkept')).toBe(true);
      expect(await vectorHas('zzleadwithdrawn')).toBe(false);
      for (const requireSafeChunks of [true, false]) {
        expect((await engine.searchKeyword('zzleadkept', { requireSafeChunks })).map(h => h.slug)).toContain('notes/lead');
        expect((await engine.searchKeyword('zzleadwithdrawn', { requireSafeChunks })).map(h => h.slug)).not.toContain('notes/lead');
      }
    }, 240_000);
  });
}
