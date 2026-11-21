/**
 * #9192 follow-up: search's response meta counted every page in scope on each
 * search while the readiness probe reported projection_pending, because it
 * read rebuild progress whenever any `protocol_activation` row was queued,
 * even rows left on images that wait for an operator, and even when none was
 * queued (the count ran under a join the planner could not skip). On a large
 * brain whose only pending pages are such images, that one read cost about
 * 1.5 s per search. The rebuild now counts as running only while an activation
 * row waits on a text page in scope, and the page count never starts otherwise:
 * the plan's scan of pages for it is never executed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { countProjectionRebuild } from '../../src/core/search/retrieval-coverage.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

for (const kind of testBackends()) {
  describe('rebuild progress reads (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let last: { sql: string; params?: unknown[] } | null = null;

    async function page(slug: string, type: string, text: string) {
      await engine.putPage(slug, { type, title: slug, compiled_truth: text, frontmatter: {} } as never);
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }]);
    }
    /** Leave a page unsealed with an activation row queued for it, as v153's activation does. */
    async function queueActivation(slug: string, image = false) {
      await engine.executeRaw(`UPDATE pages SET text_projection_revision = NULL${image ? ", page_kind = 'image'" : ''} WHERE slug = $1`, [slug]);
      await engine.executeRaw(`INSERT INTO page_projection_jobs (source_incarnation, slug, revision, reason)
        SELECT s.incarnation, p.slug, p.knowledge_revision, 'protocol_activation' FROM pages p JOIN sources s ON s.id = p.source_id WHERE p.slug = $1
        ON CONFLICT (source_incarnation, slug) DO UPDATE SET reason = EXCLUDED.reason`, [slug]);
    }
    async function progress() {
      last = null;
      return countProjectionRebuild(engine, {});
    }
    /** Scans of pages the statement's plan never started, from EXPLAIN ANALYZE of the statement just run. */
    async function pagesScansNeverRun(): Promise<number> {
      const [row] = await run('EXPLAIN (ANALYZE, FORMAT JSON) ' + last!.sql, last!.params) as Array<Record<string, unknown>>;
      const raw = Object.values(row!)[0];
      const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
      const walk = (n: PlanNode): number => (n['Relation Name'] === 'pages' && n['Actual Loops'] === 0 ? 1 : 0) + (n.Plans ?? []).reduce((a, c) => a + walk(c), 0);
      return walk(plan[0]!.Plan);
    }
    type PlanNode = { 'Relation Name'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] };
    let run: BrainEngine['executeRaw'];

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await page('notes/alpha-example', 'note', 'Alpha example note.');
      await page('notes/beta-example', 'note', 'Beta example note.');
      await page('media/frame-example', 'image', 'Frame example');
      await engine.executeRaw("DELETE FROM page_projection_jobs");
      run = engine.executeRaw.bind(engine);
      engine.executeRaw = (async (sql: string, params?: unknown[]) => { last = { sql, params }; return run(sql, params); }) as typeof engine.executeRaw;
    }, 120_000);

    afterAll(async () => {
      await close?.();
    });

    test('nothing queued: no rebuild, and the pages are never counted', async () => {
      expect(await progress()).toBeNull();
      expect(await pagesScansNeverRun()).toBeGreaterThan(0);
    });

    test('an activation row left on an image waits for an operator, not for a rebuild, and the pages are never counted', async () => {
      await queueActivation('media/frame-example', true);
      expect(await progress()).toBeNull();
      expect(await pagesScansNeverRun()).toBeGreaterThan(0);
    });

    test('an activation row on a text page is a running rebuild, counted over the pages in scope', async () => {
      await queueActivation('media/frame-example', true);
      await queueActivation('notes/alpha-example');
      const rebuild = await progress();
      expect(rebuild).not.toBeNull();
      expect(rebuild!.total).toBe(3);
      expect(rebuild!.done).toBe(1);
    });
  });
}
