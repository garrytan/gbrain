/**
 * #10500 on Postgres: a role that reads through row-level security policies.
 * The chunk policy's `page_id = ANY (ARRAY(SELECT p.id FROM pages p))` is
 * opaque to the planner (the default array length of 10), so it estimates a
 * handful of visible chunks and plans a pooled attempt as an `idx_chunks_page`
 * scan with a sort over every chunk the role can see, and `pg_stats` hides
 * `pages.source_id` from the role, so a source scope has no share. Pooled
 * attempts behind an index walk run with sorting disabled
 * (HNSW_ORDERED_POOL_SETTINGS), so the HNSW scan orders them while the exact
 * fallback keeps its sort, and a scope without statistics takes its share
 * from SCOPE_CHUNKS_SQL's count.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import { POOL_MAX_SCAN_TUPLES, type VectorPoolAttempt } from '../../src/core/search/vector-pool.ts';
import { buildVectorSearchStatement, PAGE_SOURCE_STATS_SQL, vectorStatementForms, type VectorScope } from '../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { column, planNodes, seedVectorWalkFixture, vec, type PlanNode } from '../helpers/vector-index-walk-fixture.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('vector pool under a row-security reader (Postgres, #10500)', () => {
  const reader = `vector_rls_reader_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  let owner: PostgresEngine;
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    let databaseUrl: string;
    ({ engine: owner, close, databaseUrl } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await seedVectorWalkFixture(owner);
    const secured = await owner.executeRaw<{ relname: string }>(`SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' AND relrowsecurity AND relname NOT IN ('pages', 'content_chunks')`);
    await owner.executeRaw(`CREATE ROLE ${reader} LOGIN PASSWORD '${password}'`);
    await owner.executeRaw(`GRANT USAGE ON SCHEMA public TO ${reader}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader}`);
    for (const { relname } of secured) await owner.executeRaw(`CREATE POLICY reader_all ON ${relname} FOR SELECT TO ${reader} USING (true)`);
    await owner.executeRaw(`CREATE POLICY reader_sources ON pages FOR SELECT TO ${reader} USING (source_id IN ('side', 'tiny'))`);
    await owner.executeRaw(`CREATE POLICY reader_pages ON content_chunks FOR SELECT TO ${reader} USING (page_id = ANY (ARRAY(SELECT p.id FROM pages p)))`);
    const url = new URL(databaseUrl!);
    url.username = reader;
    url.password = password;
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString(), poolSize: 1 });
  }, 120_000);

  afterAll(async () => {
    await engine?.disconnect();
    await close?.();
    const admin = new PostgresEngine();
    await admin.connect({ database_url: process.env.DATABASE_URL!, poolSize: 1 });
    try { await admin.executeRaw(`DROP ROLE IF EXISTS ${reader}`); } finally { await admin.disconnect(); }
  }, 60_000);

  test('pooled attempts behind a walk are ordered by the HNSW scan, not a sort over every visible chunk', async () => {
    const searchOpts: SearchOpts = { limit: 20, embeddingColumn: column };
    const statementFor = vectorStatementForms(chunkManifest => buildVectorSearchStatement({ dialect: 'postgres', embedding: vec(11), limit: 20, offset: 0, opts: searchOpts, chunkManifest }));
    const stmt = statementFor(true);
    expect(stmt.indexWalkSql).toBeDefined();
    type Attempt = (statementFor: unknown, attempt: VectorPoolAttempt, iterative: boolean, opts: SearchOpts, run: (tx: { unsafe: (sql: string, bound: unknown) => Promise<Record<string, unknown>[]> }, sql: string, bound: unknown) => Promise<Record<string, unknown>[]>) => Promise<Record<string, unknown>[]>;
    const attempt = (engine as unknown as { runVectorAttempt: Attempt }).runVectorAttempt.bind(engine);
    const plan = async (exact: boolean) => {
      const [row] = await attempt(statementFor, { innerLimit: stmt.innerLimit, maxScanTuples: POOL_MAX_SCAN_TUPLES, remainingMs: 8_000, exact }, true, searchOpts,
        (tx, sql, bound) => tx.unsafe(`EXPLAIN (FORMAT JSON) ${sql}`, bound));
      return planNodes((row!['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan).flatMap(node => node['Index Name'] ? [node['Index Name']] : []);
    };
    // The planner's own choice for the same statement: the policy array looks tiny, so it sorts every visible chunk.
    const sorted = await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('enable_material', 'off', true)");
      const [row] = await tx.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${stmt.sql}`, [...stmt.params]);
      return planNodes(row!['QUERY PLAN'][0]!.Plan).flatMap(node => node['Index Name'] ? [node['Index Name']] : []);
    });
    expect(sorted).toContain('idx_chunks_page');
    expect(sorted).not.toContain('idx_chunks_embedding');
    const pooled = await plan(false);
    expect(pooled).toContain('idx_chunks_embedding');
    expect(pooled).not.toContain('idx_chunks_page');
    expect(await plan(true)).not.toContain('idx_chunks_embedding');
    expect(await engine.executeRaw<{ enable_sort: string }>(`SELECT current_setting('enable_sort') AS enable_sort`)).toEqual([{ enable_sort: 'on' }]);

    const walk = spyOn(vectorPool, 'searchIndexWalk').mockResolvedValue(null);
    let results;
    try {
      results = await engine.searchVector(vec(11), searchOpts);
    } finally {
      walk.mockRestore();
    }
    // HNSW is approximate and each fresh database builds its own graph, so the reference is the pooled attempt on this graph, never the exact rows.
    const pooledRows = await attempt(statementFor, { innerLimit: stmt.innerLimit, maxScanTuples: POOL_MAX_SCAN_TUPLES, remainingMs: 8_000, exact: false }, true, searchOpts, (tx, sql, bound) => tx.unsafe(sql, bound));
    const visible = await engine.executeRaw<{ id: number }>('SELECT id FROM pages');
    expect(results).toHaveLength(20);
    expect(results!.every(row => visible.some(page => page.id === row.page_id))).toBe(true);
    expect(results!.map(row => `${row.slug}#${row.chunk_id}`)).toEqual(pooledRows.filter(row => row.page_id != null).map(row => `${row.slug}#${row.chunk_id}`));
  }, 60_000);

  test('a source scope the reader cannot see statistics for takes its share from the counted pages', async () => {
    expect(await owner.executeRaw(PAGE_SOURCE_STATS_SQL)).toHaveLength(1);
    expect(await engine.executeRaw(PAGE_SOURCE_STATS_SQL)).toEqual([]);
    const loader = (engine as unknown as { vectorScope: (o: SearchOpts) => Promise<VectorScope | undefined> }).vectorScope;
    const opts: SearchOpts = { limit: 5, embeddingColumn: column, sourceIds: ['tiny'] };
    let scope = await loader(opts);
    for (let i = 0; i < 100 && !scope; i++) scope = (await Bun.sleep(20), await loader(opts));
    const [counts] = await engine.executeRaw<{ scoped: number; all: number; chunks: number }>(`SELECT
        count(*) FILTER (WHERE source_id = 'tiny')::int AS scoped, count(*)::int AS all,
        (SELECT count(*)::int FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.source_id = 'tiny' AND p.deleted_at IS NULL) AS chunks
      FROM pages WHERE deleted_at IS NULL`);
    expect(scope).toEqual({ share: Math.round((counts!.scoped / counts!.all) * 1e6) / 1e6, chunks: counts!.chunks });
    const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding: vec(1010), limit: 5, offset: 0, opts, scope });
    expect(stmt.scopeScanSql).toBeDefined();
    const results = await engine.searchVector(vec(1010), opts);
    expect(results).toHaveLength(5);
    expect(results.every(row => row.slug.startsWith('tiny/'))).toBe(true);
  }, 30_000);
});
