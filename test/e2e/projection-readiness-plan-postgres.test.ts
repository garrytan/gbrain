/**
 * GBRA-156: the projection-readiness probe runs on every search and query and
 * a cold CLI process cannot reuse a cached answer. The planner has no
 * statistics for `text_projection_revision IS DISTINCT FROM knowledge_revision`,
 * so an EXISTS over it chose a sequential scan of pages that expected to stop
 * at the first row; on a sealed brain it read every page (~600 ms at 600k
 * pages). Pins the plan on real Postgres with analyzed, fully sealed filler
 * pages: the probe walks the partial idx_pages_projection_pending and no
 * sequential scan of pages runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { probeProjectionReadiness, type ProjectionReadinessScope } from '../../src/core/search/projection-readiness.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('projection readiness probe plan on Postgres (GBRA-156)', () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('source-a','source-a'),('source-b','source-b') ON CONFLICT DO NOTHING");
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,title,type,page_kind,compiled_truth,chunker_version,frontmatter)
      SELECT CASE WHEN i % 2 = 0 THEN 'source-a' ELSE 'source-b' END, 'filler-' || i, 'Filler ' || i, 'concept',
        CASE WHEN i % 5 = 0 THEN 'code' ELSE 'markdown' END, 'filler body ' || i, 999, '{}'::jsonb
      FROM generate_series(1, 20000) AS i`);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision');
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE sources');
  }, 120_000);

  afterAll(async () => { await close?.(); });

  async function probeStatement(scope: ProjectionReadinessScope) {
    const captured: Array<{ sql: string; params?: unknown[] }> = [];
    const recording = { executeRaw: (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return engine.executeRaw(sql, params);
    } } as unknown as BrainEngine;
    const result = await withEnv({ GBRAIN_PROJECTION_READINESS_CACHE: '0' }, () => probeProjectionReadiness(recording, scope));
    const probe = captured.find(call => call.sql.includes('IS DISTINCT FROM'));
    expect(probe).toBeDefined();
    return { result, probe: probe! };
  }

  async function plan(sql: string, params?: unknown[]): Promise<string> {
    return (await engine.executeRaw<Record<string, string>>(`EXPLAIN (ANALYZE, COSTS OFF) ${sql}`, params)).map(row => Object.values(row)[0]).join('\n');
  }

  for (const [name, scope] of [
    ['every source', {}],
    ['one source', { sourceId: 'source-a' }],
    ['a source grant without private pages', { sourceIds: ['source-a', 'source-b'], excludePrivate: true }],
  ] as Array<[string, ProjectionReadinessScope]>) {
    test(`a sealed brain answers ready from the partial index without scanning pages (${name})`, async () => {
      const { result, probe } = await probeStatement(scope);
      expect(result).toEqual({ status: 'ready', ready: true });
      const text = await plan(probe.sql, probe.params);
      expect(text).toMatch(/Index Scan using idx_pages_projection_pending on pages p\b/);
      // The private-visibility clause carries lazily evaluated subplans over pages; none may run.
      expect(text.split('\n').filter(line => line.includes('Seq Scan on pages') && !line.includes('never executed'))).toEqual([]);
    });
  }

  test('one unsealed page among the sealed filler is still found', async () => {
    await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE slug='filler-7'");
    try {
      expect((await probeStatement({ sourceId: 'source-b' })).result.status).toBe('projection_pending');
      expect((await probeStatement({ sourceId: 'source-a' })).result.status).toBe('ready');
      expect((await probeStatement({})).result.status).toBe('projection_pending');
    } finally {
      await engine.executeRaw("UPDATE pages SET text_projection_revision=knowledge_revision WHERE slug='filler-7'");
    }
  });
});
