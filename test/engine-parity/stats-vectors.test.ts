/**
 * BrainEngine parity — stats counters over stored chunk vectors, and the salience weight in the enrich order.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getStats counts every chunk with a stored vector on a page in the scope (soft-deleted and `embed_skip`
 *    pages too); getHealth counts embedded and missing chunks only on live pages without `embed_skip`; a chunk loses
 *    its vector when deleteChunks removes it. `listEnrichCandidates({ order: 'salience' })` sorts on the page's
 *    `emotional_weight`, then on inbound links. Every engine arm returns the same result.
 *  - Regression: an engine that counts embeddings from a different set of chunks than PGLite (soft-deleted pages,
 *    `embed_skip`, chunks re-written without a vector), or that reads the weight as 0 so the salience order falls back to
 *    inbound links. `gbrain stats`, `doctor`'s embed coverage and `enrich --thin` read these.
 *  - Why existing coverage misses it: config-ingest.test.ts embeds chunks only on live, eligible pages; stats.test.ts
 *    writes no vectors; code-eval-salience.test.ts never asks for the salience order.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, createSource, parityArms, pick } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HEALTH_KEYS = ['page_count', 'embed_coverage', 'missing_embeddings', 'embed_coverage_score', 'brain_score'] as const;

describe('engine parity: stats with vectors', () => {
  parityTest(
    'embedding counts cover soft-deleted and embed_skip pages in getStats only, and follow chunk rewrites and deletes',
    { methods: ['putPage', 'upsertChunks', 'softDeletePage', 'deleteChunks', 'getStats', 'getHealth'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'vec-b');
      const page = (slug: string, frontmatter?: Record<string, unknown>, sourceId?: string) =>
        engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug}.`, timeline: '', ...(frontmatter ? { frontmatter } : {}) }, sourceId ? { sourceId } : undefined);
      await page('notes/vec-live');
      await page('notes/vec-skip', { embed_skip: true });
      await page('notes/vec-gone');
      await page('notes/vec-rewrite');
      await page('notes/vec-cleared');
      await page('notes/vec-other', undefined, 'vec-b');
      await engine.upsertChunks('notes/vec-live', [
        { chunk_index: 0, chunk_text: 'Live zero.', chunk_source: 'compiled_truth', embedding: basisEmbedding(1) },
        { chunk_index: 1, chunk_text: 'Live one.', chunk_source: 'compiled_truth', embedding: basisEmbedding(2) },
        { chunk_index: 2, chunk_text: 'Live two.', chunk_source: 'timeline' },
      ]);
      await engine.upsertChunks('notes/vec-skip', [
        { chunk_index: 0, chunk_text: 'Skip zero.', chunk_source: 'compiled_truth', embedding: basisEmbedding(3) },
        { chunk_index: 1, chunk_text: 'Skip one.', chunk_source: 'compiled_truth' },
      ]);
      await engine.upsertChunks('notes/vec-gone', [
        { chunk_index: 0, chunk_text: 'Gone zero.', chunk_source: 'compiled_truth', embedding: basisEmbedding(4) },
      ]);
      await engine.upsertChunks('notes/vec-rewrite', [
        { chunk_index: 0, chunk_text: 'Rewrite zero.', chunk_source: 'compiled_truth', embedding: basisEmbedding(5) },
      ]);
      await engine.upsertChunks('notes/vec-cleared', [
        { chunk_index: 0, chunk_text: 'Cleared zero.', chunk_source: 'compiled_truth', embedding: basisEmbedding(6) },
      ]);
      await engine.upsertChunks('notes/vec-other', [
        { chunk_index: 0, chunk_text: 'Other zero.', chunk_source: 'compiled_truth', embedding: basisEmbedding(7) },
        { chunk_index: 1, chunk_text: 'Other one.', chunk_source: 'compiled_truth' },
      ], { sourceId: 'vec-b' });
      const before = {
        stats: await engine.getStats(),
        health: pick(await engine.getHealth(), HEALTH_KEYS),
      };
      await engine.softDeletePage('notes/vec-gone');
      // New text without a vector: the chunk has no vector after the write.
      await engine.upsertChunks('notes/vec-rewrite', [
        { chunk_index: 0, chunk_text: 'Rewrite zero, new text.', chunk_source: 'compiled_truth' },
      ]);
      await engine.deleteChunks('notes/vec-cleared');
      const stats = await engine.getStats();
      const def = await engine.getStats({ sourceId: 'default' });
      const other = await engine.getStats({ sourceIds: ['vec-b'] });
      const none = await engine.getStats({ sourceIds: [] });
      const health = pick(await engine.getHealth(), HEALTH_KEYS);
      const healthDefault = pick(await engine.getHealth({ sourceId: 'default' }), HEALTH_KEYS);
      const healthOther = pick(await engine.getHealth({ sourceId: 'vec-b' }), HEALTH_KEYS);
      expect(before.stats.embedded_count).toBe(7);
      expect(before.health.missing_embeddings).toBe(2);
      // soft-deleted vec-gone and embed_skip vec-skip still count in getStats.
      expect(stats.embedded_count).toBe(5);
      expect(def.embedded_count).toBe(4);
      expect(other.embedded_count).toBe(1);
      expect(none.embedded_count).toBe(0);
      // live, eligible chunks: vec-live 3 (2 embedded), vec-rewrite 1 (0), vec-other 2 (1).
      expect(health.missing_embeddings).toBe(3);
      expect(healthDefault.missing_embeddings).toBe(2);
      expect(healthOther.missing_embeddings).toBe(1);
      return { before, stats, def, other, none, health, healthDefault, healthOther };
    },
  );

  parityTest(
    'listEnrichCandidates salience order sorts on the emotional weight, then inbound links, by scope',
    { methods: ['putPage', 'addLink', 'setEmotionalWeightBatch', 'listEnrichCandidates'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'enrich-w');
      const thin = { compiled_truth: 'Stub.', timeline: '' };
      await engine.putPage('people/w-low', { type: 'person', title: 'Low', ...thin });
      await engine.putPage('people/w-high', { type: 'person', title: 'High', ...thin });
      await engine.putPage('people/w-mid', { type: 'person', title: 'Mid', ...thin });
      await engine.putPage('people/w-linked', { type: 'person', title: 'Linked', ...thin });
      await engine.putPage('people/w-plain', { type: 'person', title: 'Plain', ...thin });
      await engine.putPage('people/w-high', { type: 'person', title: 'High Other', ...thin }, { sourceId: 'enrich-w' });
      await engine.putPage('notes/w-linker', { type: 'note', title: 'Linker', compiled_truth: 'Links to people.', timeline: '' });
      await engine.addLink('notes/w-linker', 'people/w-linked', '', 'mentions_person');
      await engine.addLink('notes/w-linker', 'people/w-low', '', 'mentions_person');
      const base = { types: ['person' as const], thinThreshold: 100, order: 'salience' as const, limit: 50 };
      const view = async (opts: Partial<typeof base> & { sourceId?: string } = {}) =>
        (await engine.listEnrichCandidates({ ...base, ...opts })).map((r) => `${r.source_id}:${r.slug}|${r.inbound_count}`);
      const unweighted = await view();
      const changed = await engine.setEmotionalWeightBatch([
        { slug: 'people/w-high', source_id: 'default', weight: 0.9 },
        { slug: 'people/w-mid', source_id: 'default', weight: 0.4 },
        { slug: 'people/w-low', source_id: 'default', weight: 0.1 },
        { slug: 'people/w-high', source_id: 'enrich-w', weight: 0.2 },
      ]);
      const weighted = await view();
      const limited = await view({ limit: 2 });
      const scoped = await view({ sourceId: 'enrich-w' });
      expect(changed).toBe(4);
      // No weight anywhere: inbound links first, then the tie-break.
      expect(unweighted[0]).toMatch(/w-(linked|low)/);
      expect(weighted.slice(0, 3)).toEqual(['default:people/w-high|0', 'default:people/w-mid|0', 'enrich-w:people/w-high|0']);
      expect(limited).toHaveLength(2);
      return { unweighted, changed, weighted, limited, scoped };
    },
  );
});
