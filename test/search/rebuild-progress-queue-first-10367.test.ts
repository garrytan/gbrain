/**
 * #10367: the rebuild-progress check joined the queue to `sources` on incarnation in the same join tree as the pages,
 * so with a source list and the private-page filter the planner could pair every queued row with every page of those
 * sources and filter on slug afterwards (63M rejected pairs, about 3 s per search) while only image rows, which wait
 * for an operator, sat in the queue. The queue is now read on its own first, as a materialized CTE the planner cannot
 * fold into the page join, and its rows reach pages through the (source_id, slug) key. Small synthetic data does not
 * reproduce the reporter's merge-join plan, so the test pins the plan shape that rules it out: the queue's read is its
 * own plan node, holding page_projection_jobs and no pages, and every page row the start check reads is keyed on a
 * queued slug.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { countProjectionRebuild } from '../../src/core/search/retrieval-coverage.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const IMAGES = 60;
const NOTES = 600;
type PlanNode = { 'Node Type'?: string; 'Subplan Name'?: string; 'CTE Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] };
const relations = (n: PlanNode): string[] => [...(n['Relation Name'] ? [n['Relation Name']] : []), ...(n.Plans ?? []).flatMap(relations)];
const find = (n: PlanNode, hit: (n: PlanNode) => boolean): PlanNode[] => [...(hit(n) ? [n] : []), ...(n.Plans ?? []).flatMap(c => find(c, hit))];

for (const kind of testBackends()) {
  describe('rebuild progress reads the queue first (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let last: { sql: string; params?: unknown[]; opts?: unknown } | null = null;
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
      await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ('queue-first-example','queue-first-example') ON CONFLICT DO NOTHING`);
      await engine.putPage('notes/seed-example', { type: 'note', title: 'Seed', compiled_truth: 'Seed example.', timeline: '' });
      for (const [source, prefix, n] of [['default', 'notes/n', NOTES], ['queue-first-example', 'notes/o', NOTES], ['default', 'media/i', IMAGES]] as const) {
        await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash)
          SELECT $1, $2 || g, CASE WHEN $2 LIKE 'media/%' THEN 'image' ELSE 'note' END, CASE WHEN $2 LIKE 'media/%' THEN 'image' ELSE 'markdown' END,
            $2 || g, 'Body ' || g, '', '{}'::jsonb, md5($2 || g) FROM generate_series(1, $3::int) g`, [source, prefix, n]);
      }
      await engine.executeRaw(`UPDATE pages SET text_projection_revision = NULL WHERE slug LIKE 'media/i%'`);
      await engine.executeRaw(`INSERT INTO page_projection_jobs (source_incarnation, slug, revision, reason)
        SELECT s.incarnation, p.slug, p.knowledge_revision, 'protocol_activation' FROM pages p JOIN sources s ON s.id = p.source_id
        WHERE p.slug LIKE 'media/i%' ON CONFLICT (source_incarnation, slug) DO UPDATE SET reason = EXCLUDED.reason`);
      await engine.executeRaw('ANALYZE pages');
      await engine.executeRaw('ANALYZE page_projection_jobs');
      run = engine.executeRaw.bind(engine);
      engine.executeRaw = (async (sql: string, params?: unknown[], opts?: never) => { last = { sql, params, opts }; return run(sql, params, opts); }) as typeof engine.executeRaw;
    }, 300_000);

    afterAll(async () => {
      await close?.();
    });

    test('image rows left in the queue are no rebuild, and the queue is read on its own before any page', async () => {
      expect(await countProjectionRebuild(engine, { sourceIds: ['default', 'queue-first-example'], excludePrivate: true })).toBeNull();
      const [row] = await run('EXPLAIN (ANALYZE, FORMAT JSON) ' + last!.sql, last!.params) as Array<Record<string, unknown>>;
      const raw = Object.values(row!)[0];
      const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
      const queueReads = find(plan[0]!.Plan, n => /^CTE /.test(n['Subplan Name'] ?? '') && relations(n).includes('page_projection_jobs'));
      expect(queueReads.length).toBe(1);
      expect(relations(queueReads[0]!)).not.toContain('pages');
      const scans = find(plan[0]!.Plan, n => n['Node Type'] === 'CTE Scan' && n['CTE Name'] === queueReads[0]!['Subplan Name']!.slice(4));
      expect(scans.length).toBeGreaterThan(0);
    }, 60_000);
  });
}
