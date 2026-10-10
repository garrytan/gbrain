import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { readPageSnapshot } from '../src/core/page-state/snapshot.ts';
import { PageSnapshotAmbiguousError } from '../src/core/page-state/types.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

// #6281: alias reads must visit slug candidates, not scan the whole readable corpus.
// Existing snapshot tests cover small-brain results, not the actual execution plan.
// EXPLAIN ANALYZE observes the production query seam; no timing threshold or new seam.
type Plan = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number;
  'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number; Plans?: Plan[] };
const sources = ['snapshot-plan-a', 'snapshot-plan-b', 'snapshot-plan-hidden'];
const page = (body: string) => ({ type: 'note', title: 'Plan fixture', compiled_truth: body, timeline: '', frontmatter: {} });

for (const backend of testBackends()) describe(`alias snapshot lookup (${backend})`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
    for (const source of sources) {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [source]);
    }
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT $1,'notes/filler-'||n,'note','Filler','Body','','{}'::jsonb FROM generate_series(1,12000) n`, [sources[0]]);
    for (const source of sources) await engine.putPage('notes/target', page(source), { sourceId: source });
    await engine.executeRaw(`INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug)
      SELECT id,'notes/alias','notes/target' FROM sources WHERE id=ANY($1::text[])`, [sources]);
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE slug_aliases');
  }, 120_000);
  afterAll(async () => {
    if (!engine) return;
    for (const source of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
    await engine.disconnect();
  });

  test('exact hits, aliases and misses do not filter thousands of unrelated pages', async () => {
    for (const slug of ['notes/target', 'notes/alias', 'notes/missing']) {
      let plan!: Plan;
      const snapshot = await readPageSnapshot(async <T>(sql: string, params?: unknown[]) => {
        const rows = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
        plan = rows[0]['QUERY PLAN'][0].Plan;
        return engine.executeRaw<T>(sql, params);
      }, slug, { sourceIds: sources.slice(0, 2), resolveAlias: true, excludePrivate: true });
      expect(snapshot?.page.slug ?? null).toBe(slug === 'notes/missing' ? null : 'notes/target');
      let visited = 0;
      const visit = (node: Plan) => {
        if (node['Relation Name'] === 'pages') visited += ((node['Actual Rows'] ?? 0)
          + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Join Filter'] ?? 0)) * (node['Actual Loops'] ?? 1);
        node.Plans?.forEach(visit);
      };
      visit(plan);
      expect(visited).toBeLessThan(100);
    }
  });

  test('source ordering, exact precedence and ambiguity count distinct pages', async () => {
    const opts = { sourceIds: sources.slice(0, 2).reverse(), resolveAlias: true };
    expect((await engine.readPageSnapshot('notes/alias', opts))!.page.source_id).toBe(sources[1]);
    await expect(engine.readPageSnapshot('notes/alias', { ...opts, requireUnambiguous: true })).rejects.toBeInstanceOf(PageSnapshotAmbiguousError);
    await engine.putPage('notes/alias', page('Exact'), { sourceId: sources[0] });
    expect((await engine.readPageSnapshot('notes/alias', opts))!.page.compiled_truth).toBe('Exact');
    expect((await engine.readPageSnapshot('notes/target', { sourceId: sources[0], resolveAlias: true, requireUnambiguous: true }))!.page.slug).toBe('notes/target');
  });

  test('hidden exact identities, deleted targets and archived aliases stay fenced', async () => {
    const sourceId = sources[1];
    await engine.putPage('notes/alias', { ...page('Private exact'), frontmatter: { visibility: 'private' } }, { sourceId });
    const opts = { sourceId, resolveAlias: true, excludePrivate: true };
    expect((await engine.readPageSnapshot('notes/alias', opts))!.page.slug).toBe('notes/target');
    expect(await engine.readPageSnapshot('notes/alias', { ...opts, preserveExactIdentity: true })).toBeNull();
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [sourceId, 'notes/alias']);
    expect(await engine.readPageSnapshot('notes/alias', { ...opts, preserveExactIdentity: true })).toBeNull();
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [sourceId, 'notes/target']);
    expect(await engine.readPageSnapshot('notes/alias', opts)).toBeNull();
    expect((await engine.readPageSnapshot('notes/alias', { ...opts, includeDeleted: true }))!.page.slug).toBe('notes/target');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
    expect(await engine.readPageSnapshot('notes/alias', opts)).toBeNull();
    expect((await engine.readPageSnapshot('notes/alias', { ...opts, includeDeleted: true }))!.page.slug).toBe('notes/target');
    expect(await engine.readPageSnapshot('notes/alias', { ...opts, includeDeleted: true, requireLiveSource: true })).toBeNull();
    expect(await engine.readPageSnapshot('notes/alias', { sourceIds: ['snapshot-plan-unreadable'], resolveAlias: true })).toBeNull();
  });
});
