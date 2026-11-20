/**
 * Core memory reads (listCorePages, pendingCoreNotices) return rows in byte order of (source id, slug) on every SQL engine.
 *
 * 1. Contract: listCorePages orders live always_load pages by source id then slug, and pendingCoreNotices lists the
 *    newest pending notice of each (source id, slug) in the same order, both in byte order (a hyphen, 0x2d, sorts before
 *    a letter), the order PGLite and the Rust engine use.
 * 2. Regression: either ORDER BY sorting by the database collation. On a Postgres server whose default collation is
 *    en_US.utf8, punctuation is ignored at the first level, so source 'ab' sorts before 'a-z' and slug 'notes/ab' before
 *    'notes/a-z'; the core block and the notice list then differ from PGLite's.
 * 3. Why existing coverage misses it: test/core-memory.test.ts runs on PGLite only, and its slugs and source ids sort the
 *    same in every collation.
 * 4. Seams: none. Pages are written with putPage and notices with executeRaw; the Postgres arm uses a fresh
 *    default-collation database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { listCorePages, pendingCoreNotices } from '../src/core/core-memory.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) {
  describe(`core memory read order (${kind})`, () => {
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
      const core = { type: 'note' as const, title: 'Core', compiled_truth: 'Standing rule.', frontmatter: { always_load: true } };
      await engine.putPage('notes/ab', core);
      await engine.putPage('notes/a-z', core);
      await engine.putPage('rules/example', core, { sourceId: 'ab' });
      await engine.putPage('rules/example', core, { sourceId: 'a-z' });
      for (const [source, slug, revision] of [['ab', 'rules/example', 'r1'], ['a-z', 'rules/example', 'r1'], ['default', 'notes/ab', 'r1'],
        ['default', 'notes/a-z', 'r1'], ['default', 'notes/a-z', 'r2']]) {
        await engine.executeRaw(`INSERT INTO core_edit_notices (source_id, slug, revision, actor) VALUES ($1, $2, $3, 'alice-example')`, [source, slug, revision]);
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('listCorePages lists pages in byte order of source id, then slug', async () => {
      expect((await listCorePages(engine)).map(p => `${p.source_id}:${p.slug}`))
        .toEqual(['a-z:rules/example', 'ab:rules/example', 'default:notes/a-z', 'default:notes/ab']);
    });

    test('pendingCoreNotices lists the newest notice of each page in byte order of source id, then slug', async () => {
      expect((await pendingCoreNotices(engine)).map(n => `${n.source_id}:${n.slug}:${n.revision}`))
        .toEqual(['a-z:rules/example:r1', 'ab:rules/example:r1', 'default:notes/a-z:r2', 'default:notes/ab:r1']);
    });
  });
}
