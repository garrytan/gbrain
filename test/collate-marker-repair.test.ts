/**
 * previewMarkerRepair lists candidates and lowered pages in byte order of (source id, slug) on every SQL engine.
 *
 * 1. Contract: previewMarkerRepair returns `candidates` (pages whose stored tier is above unknown but whose frontmatter
 *    carries `trust_tier: unknown`) and `lowered` (pages with a pending lower_page proposal) ordered by source id then slug
 *    in byte order (a hyphen, 0x2d, sorts before a letter), the order PGLite and the Rust engine use. The candidate order
 *    also feeds `preview_hash`, which an apply binds to.
 * 2. Regression: either ORDER BY sorting by the database collation. On a Postgres server whose default collation is
 *    en_US.utf8, punctuation is ignored at the first level, so source 'ab' sorts before 'a-z' and slug 'cand/ab' before
 *    'cand/a-z'; the preview then lists pages, and hashes them, in a different order than PGLite.
 * 3. Why existing coverage misses it: test/trust-channel-writes.test.ts previews a few candidates whose slugs sort the same in
 *    every collation, and runs on one backend.
 * 4. Seams: none. Pages are written with putPage; the stored tier is raised through the deterministic backfill seam
 *    (withTrustBackfill) and proposals are inserted with executeRaw; the Postgres arm uses a fresh default-collation database.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { previewMarkerRepair } from '../src/core/trust/marker-repair.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

// Each key is [source id, slug], listed in the order a collation-ignoring-punctuation sort would return them.
const KEYS = (prefix: string): Array<[string, string]> => [['ab', `${prefix}/x`], ['a-z', `${prefix}/x`], ['default', `${prefix}/ab`], ['default', `${prefix}/a-z`]];
const BYTE_ORDER = (prefix: string) => [`a-z:${prefix}/x`, `ab:${prefix}/x`, `default:${prefix}/a-z`, `default:${prefix}/ab`];

for (const kind of testBackends()) {
  describe(`marker repair preview order (${kind})`, () => {
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
      const stamp = (sourceId: string, slug: string, raise: boolean) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
        await tx.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"trust_tier":"unknown"}'::jsonb WHERE source_id = $1 AND slug = $2`, [sourceId, slug]);
        if (raise) await withTrustBackfill(tx, () => tx.executeRaw(`UPDATE pages SET trust_tier = 'operator_curated' WHERE source_id = $1 AND slug = $2`, [sourceId, slug]));
      }, TEST_WRITE_ATTRIBUTION));
      for (const [prefix, raise] of [['cand', true], ['low', false]] as const) {
        for (const [sourceId, slug] of KEYS(prefix)) {
          await engine.putPage(slug, { type: 'note', title: 'Page', compiled_truth: 'Body.' }, { sourceId });
          await stamp(sourceId, slug, raise);
          if (!raise) {
            await engine.executeRaw(
              `INSERT INTO trust_proposals (action, source_id, target_table, target_id, before_state, proposer)
                 SELECT 'lower_page', source_id, 'pages', id, '{"prior_tier":"operator_curated"}'::jsonb, 'alice-example' FROM pages WHERE source_id = $1 AND slug = $2`, [sourceId, slug]);
          }
        }
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('candidates are listed in byte order of source id, then slug, and the hash follows that order', async () => {
      const preview = await previewMarkerRepair(engine);
      expect(preview.candidates.map(c => `${c.source_id}:${c.slug}`)).toEqual(BYTE_ORDER('cand'));
      const sorted = [...preview.candidates].sort((a, b) => (a.source_id === b.source_id ? (a.slug < b.slug ? -1 : 1) : a.source_id < b.source_id ? -1 : 1));
      const hash = `mr_${createHash('sha256').update(JSON.stringify(sorted.map(c => [c.source_id, c.slug, c.revision, c.stored_tier]))).digest('hex').slice(0, 16)}`;
      expect(preview.preview_hash).toBe(hash);
    });

    test('lowered pages are listed in byte order of source id, then slug', async () => {
      const preview = await previewMarkerRepair(engine);
      expect(preview.lowered.map(l => l.page)).toEqual(BYTE_ORDER('low').map(k => `p:${k.replace(':', '/')}`));
    });
  });
}
