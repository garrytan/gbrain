/**
 * untiledSegmentedPages lists pages in byte order of (source id, slug) on both SQL engines.
 *
 * 1. Contract: `untiledSegmentedPages` returns the live untiled segmented pages ordered by source id, then slug, in byte
 *    (code point) order, the order PGLite (collation C) and the Rust engine give. `limit` keeps the first rows of that order.
 * 2. Regression: the ORDER BY sorting by the database's default collation. en_US ignores punctuation at the first level, so
 *    Postgres listed slug 'notes/ab' before 'notes/a-z' and source 'ab-example' before 'a-z-example', and `limit` then cut a different page.
 * 3. Why existing coverage misses it: test/large-pages/segmented-tiling-repair.test.ts runs on PGLite only, and its slugs and
 *    source ids sort the same in every collation.
 * 4. Seams: none. Pages are inserted with `executeRaw`; with no manifest rows each segmented page's live rows cover 0 of its body_bytes, so it is untiled.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { untiledSegmentedPages } from '../src/core/page-body/body-tiling.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) {
  describe(`untiledSegmentedPages order (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      for (const source of ['a-z-example', 'ab-example']) {
        await engine.executeRaw("INSERT INTO sources(id, name, config) VALUES ($1, $1, '{}')", [source]);
      }
      // Inserted in en_US order, so a byte-order result is not the insertion order.
      for (const [source, slug] of [['ab-example', 'notes/a-z'], ['a-z-example', 'notes/ab'], ['a-z-example', 'notes/a-z'], ['ab-example', 'notes/ab']] as const) {
        await engine.executeRaw(
          `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, body_storage, body_bytes)
           VALUES ($1, $2, 'note', 'Example', NULL, NULL, 'segmented', 10)`, [source, slug]);
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const keys = (pages: Array<{ source_id: string; slug: string }>) => pages.map(p => `${p.source_id}:${p.slug}`);

    test('lists pages by source id, then slug, in byte order', async () => {
      expect(keys(await untiledSegmentedPages(engine))).toEqual([
        'a-z-example:notes/a-z', 'a-z-example:notes/ab', 'ab-example:notes/a-z', 'ab-example:notes/ab',
      ]);
    });

    test('limit keeps the first pages in byte order', async () => {
      expect(keys(await untiledSegmentedPages(engine, { limit: 2 }))).toEqual(['a-z-example:notes/a-z', 'a-z-example:notes/ab']);
    });
  });
}
