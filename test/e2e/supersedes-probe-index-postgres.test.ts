/**
 * GBRA-156: search gates its supersession stage on SUPERSEDE_EDGE_PROBE_SQL. On a brain with no `supersedes` edge (the
 * common case) the probe returns no row, so without a matching index it reads every entry of the composite links index
 * (link_type is not its leading column) or the whole table. Cold, under load, that one statement stalled a warm search
 * for seconds. The links_supersedes_index migration's partial index idx_links_supersedes_to holds only supersedes edges, so the probe reads
 * an index with no entries. This pins the planner's choice for the exact probe text on a populated links table.
 * Regression that fails it: the probe binds link_type as a parameter, or the partial index is dropped (the control).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { SUPERSEDE_EDGE_PROBE_SQL } from '../../src/core/search/hybrid.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';

const run = process.env.DATABASE_URL ? describe : describe.skip;
let engine: PostgresEngine;
let databaseUrl = '';
let close: () => Promise<void> = async () => {};

interface PlanNode { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] }
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

async function plan(sql: ReturnType<typeof postgres>, statement: string): Promise<PlanNode[]> {
  const rows = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${statement}`) as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>;
  return nodes(rows[0]!['QUERY PLAN'][0]!.Plan);
}

const usesPartialIndex = (plan: PlanNode[]) => plan.some(n => /^Index (Only )?Scan$/.test(n['Node Type']) && n['Index Name'] === 'idx_links_supersedes_to');
const readsLinksOtherwise = (plan: PlanNode[]) => plan.some(n => n['Index Name'] === 'links_from_to_type_source_origin_unique' || (n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'links'));

run('the supersede-edge probe reads the supersedes partial index, never the composite links index', () => {
  beforeAll(async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = isolated.engine;
    databaseUrl = isolated.databaseUrl;
    close = isolated.close;
    for (let i = 0; i < 40; i++) await seedPage(engine, `notes/ledger-${i}`, `Ledger entry ${i}.`);
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT f.id, t.id, ty, 's' || s FROM pages f, pages t, unnest(ARRAY['mentions', 'relates_to', 'works_at']) AS ty, generate_series(1, 10) AS s
       WHERE f.id <> t.id`);
    await engine.executeRaw('ANALYZE links');
  }, 300_000);

  afterAll(async () => { await close(); });

  test('with no supersedes edge, and with a few, the exact probe text plans an index scan on idx_links_supersedes_to', async () => {
    const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      expect(Number((await sql.unsafe('SELECT count(*)::int AS n FROM links') as Array<{ n: number }>)[0]!.n)).toBeGreaterThan(40_000);
      const empty = await plan(sql, SUPERSEDE_EDGE_PROBE_SQL);
      expect(usesPartialIndex(empty)).toBe(true);
      expect(readsLinksOtherwise(empty)).toBe(false);
      expect(await engine.executeRaw(SUPERSEDE_EDGE_PROBE_SQL)).toEqual([]);

      await sql.unsafe(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
        SELECT f.id, t.id, 'supersedes', 's1' FROM pages f JOIN pages t ON t.id = f.id + 1 LIMIT 5`);
      await sql.unsafe('ANALYZE links');
      const some = await plan(sql, SUPERSEDE_EDGE_PROBE_SQL);
      expect(usesPartialIndex(some)).toBe(true);
      expect(readsLinksOtherwise(some)).toBe(false);
      expect(await engine.executeRaw(SUPERSEDE_EDGE_PROBE_SQL)).toEqual([{ one: 1 }]);
      await sql.unsafe(`DELETE FROM links WHERE link_type = 'supersedes'`);
    } finally { await sql.end(); }
  });

  test('control: without the partial index the same probe reads the composite index or the table (the stall shape)', async () => {
    const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await sql.unsafe('BEGIN');
      await sql.unsafe('DROP INDEX idx_links_supersedes_to');
      const without = await plan(sql, SUPERSEDE_EDGE_PROBE_SQL);
      await sql.unsafe('ROLLBACK');
      expect(usesPartialIndex(without)).toBe(false);
      expect(readsLinksOtherwise(without)).toBe(true);
      expect(usesPartialIndex(await plan(sql, SUPERSEDE_EDGE_PROBE_SQL))).toBe(true);
    } finally { await sql.end(); }
  });
});
