/**
 * facts_undated_lines doctor check lists facts pages in byte order of (source id, slug) on every SQL engine.
 *
 * 1. Contract: factsUndatedLines names the first five undated facts pages, and returns details.pages, ordered by
 *    source id then slug in byte order (a hyphen, 0x2d, sorts before a letter), the order PGLite and the Rust engine use.
 * 2. Regression: the read's ORDER BY sorting by the database collation. On a Postgres server whose default collation is
 *    en_US.utf8, punctuation is ignored at the first level, so source 'ab' sorts before 'a-z' and slug 'notes/ab' before
 *    'notes/a-z'; the message and details.pages then name pages in a different order than PGLite.
 * 3. Why existing coverage misses it: test/doctor-facts-undated-lines.test.ts runs on PGLite only (C collation) and has one
 *    undated page; test/facts-doctor-shape.test.ts checks the shape, not the order of several pages.
 * 4. Seams: none. Pages are written with putPage; the Postgres arm uses a fresh default-collation database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { factsUndatedLines } from '../src/commands/doctor/checks/facts-pages.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) {
  describe(`facts_undated_lines page order (${kind})`, () => {
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
      for (const id of ['ab', 'a-z']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      const facts = { type: 'facts' as const, title: 'Facts', compiled_truth: 'True things.\n\n- an undated line\n' };
      await engine.putPage('notes/ab', facts);
      await engine.putPage('notes/a-z', facts);
      await engine.putPage('me/facts', facts, { sourceId: 'ab' });
      await engine.putPage('me/facts', facts, { sourceId: 'a-z' });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('pages are named in byte order of source id, then slug', async () => {
      const check = await factsUndatedLines(engine);
      expect(check.status).toBe('warn');
      expect((check.details as { pages: Array<{ source_id: string; slug: string }> }).pages.map(p => `${p.source_id}:${p.slug}`))
        .toEqual(['a-z:me/facts', 'ab:me/facts', 'default:notes/a-z', 'default:notes/ab']);
      const named = check.message!.indexOf('a-z:me/facts') < check.message!.indexOf('ab:me/facts')
        && check.message!.indexOf('default:notes/a-z') < check.message!.indexOf('default:notes/ab');
      expect(named).toBe(true);
    });
  });
}
