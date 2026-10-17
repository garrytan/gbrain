import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`listPages literal exclusions (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('floor-allowed', 'floor-allowed'), ('floor-denied', 'floor-denied')");
      for (const sourceId of ['floor-allowed', 'floor-denied']) {
        for (const slug of ['evidence/a', 'evidence/b', 'synthesis/new', 'literal%/hidden', 'literal_/hidden', "quote'/hidden", 'literalx/kept']) {
          await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: 'dated evidence', frontmatter: {} }, { sourceId });
        }
        await engine.putPage('private/hidden', { title: 'private', type: 'note', compiled_truth: 'private evidence', frontmatter: { visibility: 'private' } }, { sourceId });
        await engine.putPage('deleted/hidden', { title: 'deleted', type: 'note', compiled_truth: 'deleted evidence', frontmatter: {} }, { sourceId });
        await engine.softDeletePage('deleted/hidden', { sourceId });
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('excludes before LIMIT/OFFSET while preserving source and private/deleted fences', async () => {
      const options = {
        sourceId: 'floor-denied', sourceIds: ['floor-allowed'], excludePrivate: true,
        excludeSlugPrefixes: ['synthesis/', 'literal%/', 'literal_/', "quote'/"],
        sort: 'slug' as const, limit: 2,
      };
      const first = await engine.listPages(options);
      const next = await engine.listPages({ ...options, offset: 2 });
      expect(first.map(p => p.slug)).toEqual(['evidence/a', 'evidence/b']);
      expect(next.map(p => p.slug)).toEqual(['literalx/kept']);
      expect([...first, ...next].every(p => p.source_id === 'floor-allowed')).toBe(true);
    });

    test('ordinary listings are unchanged; empty prefix entries do not exclude everything', async () => {
      const options = { sourceId: 'floor-allowed', limit: 100, sort: 'slug' as const };
      const plain = await engine.listPages(options);
      expect(plain.map(p => p.slug)).toContain('synthesis/new');
      expect(plain.map(p => p.slug)).toContain('private/hidden');
      expect((await engine.listPages({ ...options, excludeSlugPrefixes: ['', ''] })).map(p => p.slug)).toEqual(plain.map(p => p.slug));
      expect((await engine.listPages({ ...options, slugPrefix: 'literal', excludeSlugPrefixes: ['literal%/', 'literal_/'] })).map(p => p.slug)).toEqual(['literalx/kept']);
    });
  });
}
