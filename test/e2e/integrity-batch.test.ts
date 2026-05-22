/**
 * E2E parity tests — scanIntegrity batch path vs sequential path.
 *
 * The batch path (Postgres-only fast path added in v0.20.x) and the sequential
 * path (engine.getAllSlugs + getPage loop) MUST return the same result for
 * every supported case, otherwise gbrain doctor reports different numbers
 * depending on engine type or whether batch was attempted.
 *
 * Codex review of the original perf commit caught a multi-source dedup
 * regression: the batch SQL scanned raw (source_id, slug) rows while
 * sequential's getAllSlugs() returned a Set<string>. v0.22.7 adds
 * SELECT DISTINCT ON (slug) to the batch SQL; these tests prove parity.
 *
 * Run: DATABASE_URL=... bun test test/e2e/integrity-batch.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { scanIntegrity } from '../../src/commands/integrity.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E integrity batch parity tests (DATABASE_URL not set)');
}

describeE2E('scanIntegrity batch parity (E2E, Postgres-only)', () => {
  beforeAll(async () => {
    await setupDB();
  });

  afterAll(async () => {
    await teardownDB();
  });

  beforeEach(async () => {
    // Clean slate per case so fixtures don't leak across describes.
    const conn = getConn();
    await conn.unsafe(`TRUNCATE pages CASCADE`);
  });

  describe('dedup', () => {
    test('multi-source duplicate slugs scan once, not once-per-source', async () => {
      const engine = getEngine();
      const conn = getConn();

      // Seed default-source page via the engine.
      await engine.putPage('people/alice', {
        type: 'person',
        title: 'Alice',
        compiled_truth: 'Alice writes about AI safety.',
        timeline: '',
        frontmatter: {},
      });

      // Seed alt-source row via raw SQL — engine.putPage doesn't take a source_id,
      // and we specifically need to test that DISTINCT ON (slug) collapses
      // the multi-source rows into one scan.
      await conn.unsafe(`
        INSERT INTO sources (id, name) VALUES ('test-source-2', 'test-source-2')
        ON CONFLICT DO NOTHING
      `);
      await conn.unsafe(`
        INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
        VALUES ('test-source-2', 'people/alice', 'person', 'Alice (alt source)',
                'Alice from another source.', '', '{}'::jsonb)
      `);

      const batchResult = await scanIntegrity(engine, { limit: 100, batchLoad: true });
      const seqResult = await scanIntegrity(engine, { limit: 100, batchLoad: false });

      // Both paths must report the same number of distinct slugs scanned.
      // Pre-fix: batch reported 2 (one per source row), sequential reported 1.
      expect(batchResult.pagesScanned).toBe(seqResult.pagesScanned);
      expect(batchResult.pagesScanned).toBe(1);
    });
  });

  describe('hits', () => {
    test('bareHits and externalHits arrays match between paths', async () => {
      const engine = getEngine();

      await engine.putPage('people/alice', {
        type: 'person',
        title: 'Alice',
        compiled_truth: 'Alice tweeted about AI safety last week.',
        timeline: '',
        frontmatter: {},
      });
      await engine.putPage('people/bob', {
        type: 'person',
        title: 'Bob',
        compiled_truth: 'Bob wrote at [example](https://example.com/bob).',
        timeline: '',
        frontmatter: {},
      });

      const batchResult = await scanIntegrity(engine, { limit: 100, batchLoad: true });
      const seqResult = await scanIntegrity(engine, { limit: 100, batchLoad: false });

      expect(batchResult.bareHits.length).toBe(seqResult.bareHits.length);
      expect(batchResult.externalHits.length).toBe(seqResult.externalHits.length);
      expect(batchResult.bareHits.map(h => h.slug).sort()).toEqual(
        seqResult.bareHits.map(h => h.slug).sort(),
      );
      expect(batchResult.externalHits.map(h => h.slug).sort()).toEqual(
        seqResult.externalHits.map(h => h.slug).sort(),
      );
    });
  });

  describe('validate', () => {
    test('validate:false (boolean) page is skipped on both paths', async () => {
      const engine = getEngine();

      await engine.putPage('people/alice', {
        type: 'person',
        title: 'Alice',
        compiled_truth: 'Alice tweeted about something.',
        timeline: '',
        frontmatter: {},
      });
      await engine.putPage('people/legacy', {
        type: 'person',
        title: 'Legacy',
        compiled_truth: 'Legacy tweeted about old stuff.',
        timeline: '',
        frontmatter: { validate: false },
      });

      const batchResult = await scanIntegrity(engine, { limit: 100, batchLoad: true });
      const seqResult = await scanIntegrity(engine, { limit: 100, batchLoad: false });

      expect(batchResult.pagesScanned).toBe(seqResult.pagesScanned);
      expect(batchResult.pagesScanned).toBe(1);
      expect(batchResult.bareHits.map(h => h.slug)).not.toContain('people/legacy');
      expect(seqResult.bareHits.map(h => h.slug)).not.toContain('people/legacy');
    });
  });

  describe('topPages', () => {
    test('topPages ordering matches between paths', async () => {
      const engine = getEngine();

      // Alice has 2 bare-tweet hits; Bob has 1.
      await engine.putPage('people/alice', {
        type: 'person',
        title: 'Alice',
        compiled_truth: 'Alice tweeted today. Alice tweeted yesterday too.',
        timeline: '',
        frontmatter: {},
      });
      await engine.putPage('people/bob', {
        type: 'person',
        title: 'Bob',
        compiled_truth: 'Bob tweeted once.',
        timeline: '',
        frontmatter: {},
      });

      const batchResult = await scanIntegrity(engine, { limit: 100, batchLoad: true });
      const seqResult = await scanIntegrity(engine, { limit: 100, batchLoad: false });

      expect(batchResult.topPages).toEqual(seqResult.topPages);
    });
  });
});
