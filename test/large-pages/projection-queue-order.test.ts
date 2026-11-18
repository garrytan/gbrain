/**
 * The segmented projection queue lists pending rows in byte order of slug (`ORDER BY j.updated_at, j.slug COLLATE "C"`).
 *
 * 1. Protects: `listPendingSegmentedProjections` returns rows that share one `updated_at` in code-point order of slug
 *    ('a-b' before 'a1' before 'a_b') on PGLite and on Postgres, whatever the server's default collation (CI Postgres
 *    sorts en_US.utf8: punctuation ignored, so 'a1' comes first); a row with an earlier `updated_at` still comes first.
 * 2. Fails when: the slug is ordered in the server's locale, so Postgres lists the queue in a different order than PGLite
 *    and the Rust store (which sort by bytes) and the drain walks pages in another order per engine.
 * 3. The drain's keyset walk (`rebuildPendingPageProjections` with `walk`) follows the same byte order, so a one-row page
 *    neither skips nor repeats a row whose slug orders differently in en_US.
 * 4. The image seal's keyset window over the same queue (`sealImageProjections`) takes rows in that byte order too.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { previewProjectionDrain, rebuildPendingPageProjections, type QueueKey } from '../../src/core/page-state/projections.ts';
import { sealImageProjections } from '../../src/core/page-state/image-seal.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../src/core/search/safe-chunks.ts';
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

    test('the drain visits rows of one updated_at in byte order of slug, once each, one row at a time', async () => {
      const slugs = ['drain/ab', 'drain/a_b', 'drain/a', 'drain/a1', 'drain/a-b'];
      for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
      await engine.executeRaw(`DELETE FROM page_projection_jobs WHERE slug<>ALL($1::text[])`, [slugs]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason,updated_at)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'canonical_change','2022-01-01T00:00:00Z'::timestamptz
        FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=ANY($1::text[])
        ON CONFLICT (source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`, [slugs]);
      // The drain preview lists the same rows in the same order.
      const preview = (await previewProjectionDrain(engine)).rows.map(row => row.slug).filter(slug => slug.startsWith('drain/'));
      expect(preview).toEqual(['drain/a', 'drain/a-b', 'drain/a1', 'drain/a_b', 'drain/ab']);
      // Each call attempts the first row after the walk position and moves the position to it; the position's slug is the row visited.
      const walk: { after?: QueueKey } = {};
      const visited: string[] = [];
      for (let call = 0; call < slugs.length + 2; call++) {
        const before = walk.after?.slug;
        await rebuildPendingPageProjections(engine, 1, { walk });
        if (walk.after?.slug === before) break;
        visited.push(walk.after!.slug);
      }
      expect(visited).toEqual(['drain/a', 'drain/a-b', 'drain/a1', 'drain/a_b', 'drain/ab']);
    }, 60_000);

    test('the image seal walks the queue in byte order of slug, so a limit of two seals the first two in that order', async () => {
      const slugs = ['seal/ab', 'seal/a_b', 'seal/a', 'seal/a1', 'seal/a-b'];
      for (const slug of slugs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: '' });
      // Dress each page as an importer-sealed image whose seal marker is missing (what sealImageProjections restores).
      await engine.executeRaw(`DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE slug=ANY($1::text[]))`, [slugs]);
      await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source,modality)
        SELECT id,0,title,'image_asset','image' FROM pages WHERE slug=ANY($1::text[])`, [slugs]);
      await engine.executeRaw(`UPDATE pages SET page_kind='image', chunker_version=$2, body_flags=COALESCE(body_flags,'{}'::jsonb) || '{"has_protected":false}'::jsonb,
        text_projection_revision=NULL WHERE slug=ANY($1::text[])`, [slugs, SAFE_FENCE_CHUNKER_VERSION]);
      await engine.executeRaw(`DELETE FROM page_projection_jobs WHERE slug<>ALL($1::text[])`, [slugs]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason,updated_at)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'pages_trigger','2023-01-01T00:00:00Z'::timestamptz
        FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=ANY($1::text[])
        ON CONFLICT (source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`, [slugs]);
      expect((await sealImageProjections(engine, { limit: 2 })).sealed).toBe(2);
      const sealed = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE slug=ANY($1::text[]) AND text_projection_revision=knowledge_revision ORDER BY slug COLLATE "C"`, [slugs]);
      expect(sealed.map(row => row.slug)).toEqual(['seal/a', 'seal/a-b']);
    }, 60_000);
  });
}
