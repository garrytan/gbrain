/**
 * #6728 on Postgres: the index walk reaches chunks and pages through one key
 * probe per ANN row, so no scope-wide chunk-page join is materialized and
 * rescanned under the ANN loop. Same fixture and assertions as the PGLite
 * plan test in test/search/vector-index-walk.test.ts, in a dedicated
 * database so the shared schema keeps its dimensions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
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
});
