/**
 * #6728 on Postgres: the index walk reaches chunks and pages through one key
 * probe per ANN row, so no scope-wide chunk-page join is materialized and
 * rescanned under the ANN loop, and the joined statement behind the walk
 * never rescans a materialized page filter per HNSW candidate. Same fixture
 * and assertions as the PGLite plan tests in
 * test/search/vector-index-walk.test.ts, in a dedicated database so the
 * shared schema keeps its dimensions. The joined statement's rows are judged
 * under exact evaluation: each settings set's rows are read with index scans
 * off and compared with the statement's exact window. Its plan is read with
 * index scans on, where the planner may answer with an exact scope-first scan
 * once the materialized join is ruled out, while the materialized plan walks
 * HNSW. An HNSW window is approximate and depends on the graph each fresh
 * database builds with random levels, so no HNSW plan's rows are a reference.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import * as vectorSettings from '../../src/core/search/vector-settings.ts';
import { buildVectorSearchStatement, INDEX_WALK_SETTINGS } from '../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { column, planNodes, seedVectorWalkFixture, vec, type PlanNode } from '../helpers/vector-index-walk-fixture.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('vector index walk key probes (Postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await seedVectorWalkFixture(engine);
  }, 120_000);
  afterAll(async () => { await close?.(); });

  test('the walk probes chunks and pages by key per ANN row: no scope-wide join is materialized under the ANN loop (#6728)', async () => {
    for (const sourceIds of [['side'], ['tiny', 'side']]) {
      const opts: SearchOpts = { embeddingColumn: column, excludePrivate: true, sourceIds };
      const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding: vec(11), limit: 20, offset: 0, opts, scope: { share: 0.05 } });
      expect(stmt.indexWalkSql).toBeDefined();
      const plan = await engine.transaction(async tx => {
        for (const [key, value] of Object.entries(INDEX_WALK_SETTINGS)) await tx.executeRaw(`SET LOCAL ${key} = ${value}`);
        const [row] = await tx.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${stmt.indexWalkSql!}`, [...stmt.params]);
        return row!['QUERY PLAN'][0]!.Plan;
      });
      const nodes = planNodes(plan);
      expect(nodes.filter(node => node['Node Type'] === 'Materialize')).toEqual([]);
      expect(nodes.filter(node => node['Join Filter']?.includes('ann.id'))).toEqual([]);
      expect(nodes.find(node => node['Index Name'] === 'idx_chunks_embedding')).toBeDefined();
      for (const index of ['content_chunks_pkey', 'pages_pkey']) {
        expect(nodes.find(node => node['Index Name'] === index && node['Actual Loops']! > 1)).toBeDefined();
      }
      expect(nodes.some(node => node['Index Name'] === 'idx_chunks_page')).toBe(false);
    }
  }, 60_000);

  test('the joined statement behind the walk never materializes the filtered pages and rescans them per HNSW candidate, and returns the same rows', async () => {
    const materializedPages = (nodes: PlanNode[]) => nodes.filter(node => node['Node Type'] === 'Materialize' && planNodes(node).some(inner => inner['Relation Name'] === 'pages')).map(node => node['Node Type']);
    const shape = (rows: Record<string, unknown>[]) => rows.filter(row => row.page_id != null).map(row => [row.slug, row.chunk_id, Number(row.score).toFixed(9)]);
    for (const opts of [{ excludePrivate: true }, { excludePrivate: true, sourceIds: ['default', 'side'] }] as SearchOpts[]) {
      const searchOpts: SearchOpts = { limit: 20, embeddingColumn: column, ...opts };
      const applied: Array<Record<string, string>> = [];
      const original = vectorSettings.vectorScanSettings;
      const walk = spyOn(vectorPool, 'searchIndexWalk').mockResolvedValue(null);
      const settings = spyOn(vectorSettings, 'vectorScanSettings').mockImplementation((...args) => {
        const value = original(...args);
        applied.push(value);
        return value;
      });
      try {
        await engine.searchVector(vec(11), searchOpts);
      } finally {
        walk.mockRestore();
        settings.mockRestore();
      }
      const { statement_timeout: _timeout, ...pool } = applied[0]!;
      const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding: vec(11), limit: 20, offset: 0, opts: searchOpts });
      expect(stmt.indexWalkSql).toBeDefined();
      const run = (values: Record<string, string>) => engine.transaction(async tx => {
        for (const [name, value] of Object.entries(values)) await tx.executeRaw('SELECT set_config($1, $2, true)', [name, value]);
        const [row] = await tx.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${stmt.sql}`, [...stmt.params]);
        await tx.executeRaw("SELECT set_config('enable_indexscan', 'off', true)");
        return { nodes: planNodes(row!['QUERY PLAN'][0]!.Plan), rows: await tx.executeRaw<Record<string, unknown>>(stmt.sql, [...stmt.params]) };
      });
      const exact = await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('enable_indexscan', 'off', true)");
        return tx.executeRaw<Record<string, unknown>>(stmt.sql, [...stmt.params]);
      });
      const joined = await run(pool);
      expect(materializedPages(joined.nodes)).toEqual([]);
      expect(joined.nodes.flatMap(node => node['Join Filter']?.includes('page_id') ? [node['Join Filter']] : [])).toEqual([]);
      const materialized = await run({ ...pool, enable_material: 'on' });
      expect(materializedPages(materialized.nodes)).not.toEqual([]);
      expect(shape(joined.rows)).toHaveLength(20);
      expect(shape(joined.rows)).toEqual(shape(exact));
      expect(shape(materialized.rows)).toEqual(shape(exact));
    }
  }, 60_000);
});
