/**
 * The segmented projection queue lists pending rows in byte order of slug (`ORDER BY j.updated_at, j.slug COLLATE "C"`).
 *
 * 1. Protects: `listPendingSegmentedProjections` returns rows that share one `updated_at` in code-point order of slug
 *    ('a-b' before 'a1' before 'a_b') on PGLite and on Postgres, whatever the server's default collation (CI Postgres
 *    sorts en_US.utf8: punctuation ignored, so 'a1' comes first); a row with an earlier `updated_at` still comes first.
 * 2. Fails when: the slug is ordered in the server's locale, so Postgres lists the queue in a different order than PGLite
 *    and the Rust store (which sort by bytes) and the drain walks pages in another order per engine.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

// Slugs are lower case. en_US.utf8 ignores the punctuation of 'a-b' and 'a_b' (so 'a1' sorts before both); byte order puts '-' before '1' before '_'.
const SLUGS = ['notes/ab', 'notes/a_b', 'notes/a', 'notes/a1', 'notes/a-b', 'notes/early'];

for (const kind of testBackends()) {
  describe(`segmented projection queue order (${kind})`, () => {
    let engine: BrainEngine;
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
    afterAll(async () => { await close?.(); });

    test('rows of one updated_at list in byte order of slug, after an earlier row', async () => {
      for (const slug of SLUGS) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
      await engine.executeRaw(`UPDATE pages SET body_storage='segmented', compiled_truth=NULL, timeline=NULL, body_bytes=1 WHERE slug=ANY($1::text[])`, [SLUGS]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason,updated_at)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'canonical_change',
          CASE WHEN p.slug='notes/early' THEN '2020-01-01T00:00:00Z'::timestamptz ELSE '2021-01-01T00:00:00Z'::timestamptz END
        FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=ANY($1::text[])
        ON CONFLICT (source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`, [SLUGS]);
      const listed = (await engine.listPendingSegmentedProjections({ limit: 10 })).map(job => job.slug);
      expect(listed).toEqual(['notes/early', 'notes/a', 'notes/a-b', 'notes/a1', 'notes/a_b', 'notes/ab']);
    }, 60_000);
  });
}
