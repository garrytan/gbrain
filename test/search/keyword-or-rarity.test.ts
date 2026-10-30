/**
 * Rare words in the keyword arm's OR fallback (search/keyword-or-rarity.ts),
 * on PGLite here and on PostgreSQL through
 * test/e2e/keyword-or-rarity-postgres.test.ts. When no chunk holds every
 * query word, ts_rank ranked every chunk naming the common word several times
 * above the one page holding the rare word.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const REMOTE = { requireSafeChunks: true, excludePrivate: true };

for (const kind of testBackends()) {
  describe(`keyword OR fallback rarity (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);

    afterAll(async () => {
      await close?.();
      resetGateway();
    });

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
    });

    async function page(slug: string, title: string, body: string) {
      await engine.putPage(slug, { type: 'note', title, compiled_truth: body });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
    }

    async function seed() {
      for (let i = 1; i <= 40; i++) await page(`notes/acme-sync-${i}`, `Acme weekly sync ${i}`, `Acme sync ${i}: the Acme team reviewed the Acme roadmap.`);
      await page('notes/quokka', 'Quokka', 'Field notes about the quokka.');
    }

    test('the page holding the rare word ranks first in the keyword arm and end to end', async () => {
      await seed();
      for (const opts of [{}, REMOTE]) {
        const rows = await engine.searchKeyword('Acme Quokka', { ...opts, limit: 10, orFallback: true });
        expect(rows[0]?.slug).toBe('notes/quokka');
        expect(rows.every((r) => r.keyword_relaxed === true)).toBe(true);
        expect(rows.length).toBe(10);
        const results = await hybridSearch(engine, 'Acme Quokka', { ...opts, limit: 5, expansion: false });
        expect(results[0]?.slug).toBe('notes/quokka');
      }
    }, 120_000);

    test('a rare page past the retry limit comes back', async () => {
      await seed();
      const rows = await engine.searchKeyword('Acme Quokka', { limit: 3, orFallback: true });
      expect(rows.map((r) => r.slug)).toContain('notes/quokka');
      expect(rows.length).toBe(3);
    }, 120_000);

    test('with no rare word the retry keeps its order', async () => {
      await seed();
      const strictOr = await engine.searchKeyword('acme OR roadmap', { limit: 10 });
      const relaxed = await engine.searchKeyword('acme roadmap zebra', { limit: 10, orFallback: true });
      expect(relaxed.map((r) => r.slug)).toEqual(strictOr.map((r) => r.slug));
    }, 120_000);

    test('a paged retry (offset) keeps its order', async () => {
      await seed();
      const rows = await engine.searchKeyword('Acme Quokka', { limit: 5, offset: 5, orFallback: true });
      expect(rows.map((r) => r.slug)).not.toContain('notes/quokka');
    }, 120_000);
  });
}
