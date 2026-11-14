/**
 * #9350: readPageSnapshotsBatch reads a source's source-wide ('*') fact withdrawals once per batch,
 * not once per page. Measured from EXPLAIN (ANALYZE) of the statement it sends (no wall-clock thresholds);
 * the snapshots still carry the '*' rows plus a page-subject row.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readPageSnapshotsBatch } from '../src/core/page-snapshot-batch.ts';

const PAGES = 20;
const STAR = 400;

type PlanNode = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; Plans?: PlanNode[] };
function rowsVisited(node: PlanNode): number {
  const own = node['Relation Name'] === 'fact_withdrawals'
    ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + rowsVisited(child), 0);
}

let engine: BrainEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
    SELECT 'default','notes/p-' || g,'note','P ' || g,'body ' || g FROM generate_series(1,$1::int) g`, [PAGES]);
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
    SELECT 'default','world','*','star-' || g FROM generate_series(1,$1::int) g`, [STAR]);
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES ('default','private','notes/p-1','own-1')`);
  await engine.executeRaw('ANALYZE fact_withdrawals');
  await engine.executeRaw('ANALYZE pages');
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

test('source-wide withdrawals are not re-read for every page of a batch', async () => {
  const refs = Array.from({ length: PAGES }, (_, i) => ({ slug: `notes/p-${i + 1}`, sourceId: 'default' }));
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = (async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params: params ?? [] });
    return engine.executeRaw(sql, params);
  }) as Parameters<typeof readPageSnapshotsBatch>[0];
  const batch = await readPageSnapshotsBatch(query, refs);
  const main = statements.find(s => s.sql.includes('fact_withdrawals'))!;
  const plan = await engine.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${main.sql}`, main.params);
  const raw = Object.values(plan[0])[0];
  const root = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  const visited = rowsVisited(root[0].Plan);
  expect(batch.snapshots.get('default\u0000notes/p-2')!.withdrawals.length).toBe(STAR);
  expect(batch.snapshots.get('default\u0000notes/p-1')!.withdrawals.length).toBe(STAR + 1);
  expect(visited).toBeLessThan(STAR * 3);
});
