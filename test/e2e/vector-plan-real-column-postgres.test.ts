/**
 * #5824 plan proof on the real `embedding` column. The content-freshness test
 * (`embedded_text_hash = md5(chunk_text)`) has no planner statistics; inside
 * the HNSW candidate CTE Postgres estimated it at 0.5%, dropped
 * idx_chunks_embedding for a sequential scan, and the vector arm hit its 8 s
 * deadline on large brains. EXPLAIN is the discriminator, not latency:
 *
 *   1. precondition: the pre-fix guard placement (the legacy-guard variant,
 *      byte-for-byte the guard 3a284ae emitted) does NOT use the index on this
 *      fixture, so an undersized fixture fails loudly instead of passing;
 *   2. the statement searchVector emits first (the index walk) uses
 *      idx_chunks_embedding, through the same tx.unsafe path, scoped read
 *      transaction and scan settings (PostgresEngine.explainVectorSearch),
 *      across a filter matrix incl. remote readers, wide windows and RLS;
 *   3. stale-heavy pools escalate or fall back exactly instead of underfilling;
 *   4. doctor `vector_plan` reports each outcome;
 *   5. a source scope holding few chunks skips the walk and runs the exact
 *      scope scan first, reaching chunks through idx_chunks_page.
 *
 * Runs in a dedicated 64-dim database created on the E2E server and dropped in
 * afterAll, so the shared 1536-dim schema is untouched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import { buildVectorSearchStatement, INDEX_WALK_MIN_SCOPE_SHARE, PAGE_SOURCE_STATS_SQL, SCOPE_SCAN_FIRST_MAX_CHUNKS, sourceScope, type PageSourceStats } from '../../src/core/search/vector-statement.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import type { VectorPoolAttempt, VectorPoolBatch } from '../../src/core/search/vector-pool.ts';
import { vectorPlanCheck } from '../../src/commands/doctor/checks/vector-plan.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DIM = 64;
const MODEL = 'openai:text-embedding-3-small';
// Fixture size, measured once on PostgreSQL 16.15 + pgvector 0.8.7 with
// ANALYZE'd statistics: the fixed statement switches to idx_chunks_embedding
// at about 2,000 chunks while the pre-fix guard never does. 3,000 pages x 4
// chunks = 12,000 keeps a 6x margin and clears doctor's 10,000-chunk floor.
// Re-measure (scale PAGES until the precondition holds) when a Postgres or
// pgvector upgrade moves the flip point.
const PAGES = 3_000;
const column = { name: 'embedding', type: 'vector' as const, dimensions: DIM, embeddingModel: MODEL };
const query = new Float32Array(DIM).map((_, i) => Math.sin(i * 1.7) * 0.5);
type PoolMeta = Parameters<NonNullable<SearchOpts['onVectorPoolMeta']>>[0];

const adminUrl = process.env.GBRAIN_PGBOUNCER_DIRECT_URL ?? process.env.DATABASE_URL ?? '';
const dbName = `gbrain_test_vector_plan_${randomUUID().replaceAll('-', '')}`;
const role = `gbrain_vector_plan_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let admin: ReturnType<typeof postgres> | undefined;
let seedEngine: PostgresEngine;
let engine: PostgresEngine;
const statements: Array<{ sql: string; params: unknown[] }> = [];
const originalPool = vectorPool.searchVectorPool;
let poolSpy: ReturnType<typeof spyOn> | undefined;

function usesIndex(plan: unknown): boolean {
  return JSON.stringify(plan).includes('"Index Name":"idx_chunks_embedding"');
}

function scans(plan: unknown): string {
  return JSON.stringify(plan).match(/"Node Type":"[^"]+"/g)?.join(' > ') ?? '';
}

async function versions(): Promise<string> {
  const [row] = await engine.executeRaw<{ pg: string; vector: string }>(
    `SELECT current_setting('server_version') AS pg, (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`);
  return `PostgreSQL ${row.pg}, pgvector ${row.vector}`;
}

/** Records each `run` attempt and the pool counts it returned. */
function spyAttempts(): Array<VectorPoolAttempt & { batch?: VectorPoolBatch }> {
  const attempts: Array<VectorPoolAttempt & { batch?: VectorPoolBatch }> = [];
  poolSpy = spyOn(vectorPool, 'searchVectorPool').mockImplementation((limit, initial, iterative, indexed, kind, run, hasMore, onMeta) =>
    originalPool(limit, initial, iterative, indexed, kind, async attempt => {
      const record: VectorPoolAttempt & { batch?: VectorPoolBatch } = { ...attempt };
      attempts.push(record);
      record.batch = await run(attempt);
      return record.batch;
    }, hasMore, onMeta));
  return attempts;
}

/** A cluster of `count` chunks along the (e_a, e_b) arc at angle i * step, closer to e_a than any background row. */
async function seedCluster(prefix: string, count: number, axes: [number, number], step: number, row: (i: number) => { hash: 'current' | 'stale'; type?: string }) {
  const values = Array.from({ length: count }, (_, i) => row(i));
  await seedEngine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
    SELECT '${prefix}-' || i, 'default', t.type, '${prefix} ' || i, 'cluster', '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid, 4
    FROM unnest($1::text[]) WITH ORDINALITY AS t(type, n), LATERAL (SELECT n - 1 AS i) idx`, [values.map(v => v.type ?? 'note')]);
  await seedEngine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
    SELECT p.id, 0, 'cluster text ' || p.slug, 'compiled_truth', '${MODEL}',
      CASE WHEN h.stale = 'stale' THEN md5('text before the edit') ELSE md5('cluster text ' || p.slug) END,
      (SELECT array_agg(CASE WHEN d = ${axes[0]} THEN cos(a) WHEN d = ${axes[1]} THEN sin(a) ELSE 0 END ORDER BY d)::real[]::vector
         FROM generate_series(1, ${DIM}) d)
    FROM pages p
    JOIN unnest($1::text[]) WITH ORDINALITY AS h(stale, n) ON p.slug = '${prefix}-' || (h.n - 1)
    CROSS JOIN LATERAL (SELECT (h.n - 1) * ${step} AS a) ang`, [values.map(v => v.hash)]);
  await seedEngine.executeRaw('ANALYZE content_chunks');
  await seedEngine.executeRaw('ANALYZE pages');
}

function axis(d: number): Float32Array {
  const v = new Float32Array(DIM);
  v[d - 1] = 1;
  return v;
}

(hasDatabase() ? describe : describe.skip)('#5824 vector plan on the real embedding column (Postgres)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    try {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
    } catch (error) {
      throw new Error(`Lane A plan test needs CREATEDB on the E2E server; run via \`bun run ci:local\`. The connecting role needs CREATEDB `
        + `and permission to CREATE EXTENSION vector in the new database (${error instanceof Error ? error.message : String(error)}).`);
    }
    // Default planner costs and parallelism for every session, so the
    // baseline flip is deterministic regardless of the server's postgresql.conf.
    await admin.unsafe(`ALTER DATABASE ${dbName} SET max_parallel_workers_per_gather = 2`);
    for (const [name, value] of [['random_page_cost', '4'], ['seq_page_cost', '1'], ['cpu_tuple_cost', '0.01'], ['cpu_index_tuple_cost', '0.005'],
      ['cpu_operator_cost', '0.0025'], ['effective_cache_size', "'4GB'"], ['jit', 'off']]) {
      await admin.unsafe(`ALTER DATABASE ${dbName} SET ${name} = ${value}`);
    }
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIM, env: {} });
    seedEngine = new PostgresEngine();
    await seedEngine.connect({ database_url: url.toString(), poolSize: 2 });
    await seedEngine.initSchema();
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString(), poolSize: 1 });

    const scoped = engine as unknown as { withScopedReadTransaction: (...args: any[]) => Promise<any> };
    const original = scoped.withScopedReadTransaction;
    scoped.withScopedReadTransaction = function (sourceIds, sourceId, fn, options) {
      return original.call(this, sourceIds, sourceId, (tx: any) => fn(new Proxy(tx, {
        get(target, key) {
          if (key !== 'unsafe') return Reflect.get(target, key);
          return (sql: string, params: unknown[]) => {
            if (sql.includes('WITH hnsw_candidates') || sql.includes('WITH ann AS MATERIALIZED') || sql.includes('WITH scope_scan AS MATERIALIZED')) statements.push({ sql, params: [...params] });
            return target.unsafe(sql, params);
          };
        },
      })), options);
    };
  }, 120_000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await engine?.disconnect();
    await seedEngine?.disconnect();
    resetGateway();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  }, 60_000);

  afterEach(() => {
    poolSpy?.mockRestore();
    poolSpy = undefined;
  });

  test('doctor skips an empty brain and a small one', async () => {
    const empty = await vectorPlanCheck(engine, { column });
    expect(empty).toMatchObject({ name: 'vector_plan', status: 'ok', details: { outcome: 'skipped', reason: 'small_brain', embedded_chunks_estimate: 0 } });
    await seedEngine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'notes/n-' || i, 'default', 'note', 'Note ' || i, 'body', '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4
      FROM generate_series(0, 99) i`);
    await seedEngine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
      SELECT p.id, 0, 'chunk ' || p.id, 'compiled_truth', '${MODEL}', md5('chunk ' || p.id), e.v
      FROM pages p CROSS JOIN LATERAL (SELECT array_agg(random()::real - 0.5)::vector AS v FROM generate_series(1, ${DIM}) WHERE p.id > 0) e`);
    await seedEngine.executeRaw('ANALYZE content_chunks');
    const small = await vectorPlanCheck(engine, { column });
    expect(small).toMatchObject({ status: 'ok', details: { outcome: 'skipped', reason: 'small_brain', embedded_chunks_estimate: 100 } });
    expect(small.message).toContain('below 10000');
    await seedEngine.executeRaw('DELETE FROM content_chunks');
    await seedEngine.executeRaw('DELETE FROM pages');
  }, 60_000);

  test('the fixture reproduces the pre-fix seq scan, and the emitted statement uses idx_chunks_embedding', async () => {
    await seedEngine.executeRaw(`INSERT INTO sources (id, name) VALUES ('side', 'side') ON CONFLICT (id) DO NOTHING`);
    await seedEngine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    await seedEngine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version, effective_date)
      SELECT 'notes/n-' || i, CASE WHEN i % 10 = 0 THEN 'side' ELSE 'default' END, CASE WHEN i % 5 = 0 THEN 'concept' ELSE 'note' END,
        'Note ' || i, 'body', '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4,
        DATE '2024-01-01' + (i % 600)
      FROM generate_series(0, ${PAGES - 1}) i`);
    // 99.9% current hashes, 0.1% legacy NULL hashes: the reporter's shape.
    await seedEngine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
      SELECT p.id, c, 'chunk ' || p.id || ' ' || c, 'compiled_truth', '${MODEL}',
        CASE WHEN (p.id * 4 + c) % 1000 = 0 THEN NULL ELSE md5('chunk ' || p.id || ' ' || c) END, e.v
      FROM pages p CROSS JOIN generate_series(0, 3) c
      CROSS JOIN LATERAL (SELECT array_agg(random()::real - 0.5)::vector AS v FROM generate_series(1, ${DIM}) WHERE p.id > 0 AND c >= 0) e`);
    await seedEngine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
      await tx.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
    });
    for (const table of ['content_chunks', 'pages', 'sources']) await seedEngine.executeRaw(`ANALYZE ${table}`);
    await refreshProjectionStatistics(seedEngine);

    const legacy = await engine.explainVectorSearch(query, { limit: 20, embeddingColumn: column, vectorLegacyGuard: true });
    if (usesIndex(legacy)) {
      throw new Error(`Precondition failed on ${await versions()}: the pre-fix guard placement already uses idx_chunks_embedding at ${PAGES * 4} chunks, `
        + `so this fixture cannot discriminate. Re-measure: raise PAGES until the legacy-guard EXPLAIN shows a sequential scan, then pin it here.`);
    }
    console.info(JSON.stringify({ metric: 'vector-plan-5824', variant: 'pre-fix guard', plan: scans(legacy) }));

    const start = statements.length;
    const fixed = await engine.explainVectorSearch(query, { limit: 20, embeddingColumn: column });
    console.info(JSON.stringify({ metric: 'vector-plan-5824', variant: 'emitted', plan: scans(fixed) }));
    expect(usesIndex(fixed)).toBe(true);

    const events: PoolMeta[] = [];
    const hits = await engine.searchVector(query, { limit: 20, embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
    expect(hits).toHaveLength(20);
    expect(events).toEqual([]);
    // The EXPLAIN ran exactly the statement and parameters searchVector sent.
    const [explained, searched] = statements.slice(start);
    expect(explained.sql).toBe(`EXPLAIN (FORMAT JSON) ${searched.sql}`);
    expect(explained.params).toEqual(searched.params);
    expect(searched.sql).toBe(buildVectorSearchStatement({ dialect: 'postgres', embedding: query, limit: 20, offset: 0, opts: { embeddingColumn: column } }).indexWalkSql!);

    // Diagnostic only: the generic plan (no parameter values), PG16+.
    const generic = await engine.executeRaw(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${searched.sql}`).catch(error => String(error));
    console.info(JSON.stringify({ metric: 'vector-plan-5824', variant: 'generic plan (diagnostic)', usesIndex: usesIndex(generic) }));
  }, 60_000);

  test('the indexed path keeps idx_chunks_embedding across common filters and RLS scope binding', async () => {
    const matrix: Array<[string, SearchOpts]> = [
      ['default scope', {}],
      ['sourceIds covering most rows', { sourceIds: ['default', 'side'] }],
      ['common type', { type: 'note' }],
      ['wide date range', { afterDate: '2000-01-01', beforeDate: '2100-01-01' }],
      ['remote reader (private-page rule)', { excludePrivate: true }],
      ['remote reader, 50-row limit', { excludePrivate: true, limit: 50 }],
      ['200-row limit', { limit: 200 }],
    ];
    for (const [label, opts] of matrix) {
      const plan = await engine.explainVectorSearch(query, { limit: 20, embeddingColumn: column, ...opts });
      expect({ label, uses: usesIndex(plan), plan: scans(plan) }).toMatchObject({ label, uses: true });
    }

    await seedEngine.executeRaw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await seedEngine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await seedEngine.executeRaw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await seedEngine.executeRaw(`CREATE POLICY ${role}_pages ON pages FOR SELECT TO ${role}
      USING (current_setting('app.scopes', true) = '*' OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')))`);
    await seedEngine.executeRaw('ALTER TABLE pages ENABLE ROW LEVEL SECURITY');
    const open = (await seedEngine.executeRaw<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema() AND rowsecurity AND tablename <> 'pages'`)).map(row => row.t);
    for (const table of open) await seedEngine.executeRaw(`CREATE POLICY ${role}_open ON ${table} FOR SELECT TO ${role} USING (true)`);
    const saved = process.env.GBRAIN_RLS_SCOPE_BINDING;
    process.env.GBRAIN_RLS_SCOPE_BINDING = '1';
    try {
      const plan = await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL ROLE ${role}`);
        return (tx as PostgresEngine).explainVectorSearch(query, { limit: 20, embeddingColumn: column, sourceIds: ['default', 'side'] });
      });
      expect({ label: 'RLS scope binding', uses: usesIndex(plan), plan: scans(plan) }).toMatchObject({ uses: true });
      const hits = await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL ROLE ${role}`);
        return tx.searchVector(query, { limit: 20, embeddingColumn: column, sourceId: 'side' });
      });
      expect(hits).toHaveLength(20);
      expect(hits.every(hit => hit.source_id === 'side')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GBRAIN_RLS_SCOPE_BINDING;
      else process.env.GBRAIN_RLS_SCOPE_BINDING = saved;
      await seedEngine.executeRaw('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
    }
  }, 60_000);

  test('doctor reports ok, an unused valid index, an INVALID index, and a configured legacy guard', async () => {
    const ok = await vectorPlanCheck(engine, { column });
    expect(ok).toMatchObject({ status: 'ok', details: { outcome: 'ok' } });
    expect(ok.message).toContain('idx_chunks_embedding');

    await engine.executeRaw('SET enable_indexscan = off');
    try {
      const unused = await vectorPlanCheck(engine, { column });
      expect(unused).toMatchObject({ status: 'warn', details: { outcome: 'index_unused' } });
      expect(unused.message).toContain('does not use the HNSW index');
      expect(unused.message).toContain('idx_chunks_embedding exists and is valid');
      expect(unused.message).toContain('8 s budget');
      expect(unused.message).toContain('search.vector_legacy_guard');
    } finally {
      await engine.executeRaw('RESET enable_indexscan');
    }

    await seedEngine.executeRaw(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_chunks_embedding'::regclass`);
    try {
      const invalid = await vectorPlanCheck(engine, { column });
      expect(invalid).toMatchObject({ status: 'warn', details: { outcome: 'index_unused' } });
      expect(invalid.message).toContain('idx_chunks_embedding is INVALID');
      expect(invalid.message).toContain('REINDEX INDEX CONCURRENTLY idx_chunks_embedding');
    } finally {
      await seedEngine.executeRaw(`UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'idx_chunks_embedding'::regclass`);
    }

    const viaEnv = await vectorPlanCheck(engine, { column, env: { GBRAIN_VECTOR_LEGACY_GUARD: '1' } });
    expect(viaEnv).toMatchObject({ status: 'warn', details: { outcome: 'legacy_guard', legacy_guard: { enabled: true, via: 'env' } } });
    expect(viaEnv.message).toContain('active after restarting the owning service');
    expect(viaEnv.message).toContain('Legacy guard active; remove after upgrade');
    await seedEngine.setConfig('search.vector_legacy_guard', 'true');
    try {
      const viaConfig = await vectorPlanCheck(engine, { column, env: {} });
      expect(viaConfig).toMatchObject({ status: 'warn', details: { outcome: 'legacy_guard', legacy_guard: { enabled: true, via: 'config' } } });
    } finally {
      await seedEngine.executeRaw(`DELETE FROM config WHERE key = 'search.vector_legacy_guard'`);
    }
  }, 60_000);

  test('a window full of stale chunks escalates and fills from current chunks', async () => {
    // 300 stale chunks nearest e_1, then 30 current ones: the first 100-row
    // raw window is entirely stale.
    await seedCluster('stale-wall', 330, [1, 2], 0.0005, i => ({ hash: i < 300 ? 'stale' : 'current' }));
    const attempts = spyAttempts();
    const events: PoolMeta[] = [];
    const hits = await engine.searchVector(axis(1), { limit: 10, embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
    expect(hits.map(hit => hit.slug)).toEqual(Array.from({ length: 10 }, (_, i) => `stale-wall-${300 + i}`));
    expect(attempts.map(a => [a.innerLimit, a.exact])).toEqual([[100, false], [400, false]]);
    expect(attempts[0].batch).toMatchObject({ candidatePool: 100, eligiblePool: 0 });
    expect(events).toEqual([]);
  }, 60_000);

  test('without iterative scan the exact fallback still returns only current chunks', async () => {
    const capability = engine as unknown as { vectorIterativeScan?: Promise<boolean> };
    const previous = capability.vectorIterativeScan;
    capability.vectorIterativeScan = Promise.resolve(false);
    try {
      const attempts = spyAttempts();
      const events: PoolMeta[] = [];
      const hits = await engine.searchVector(axis(1), { limit: 10, embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
      expect(attempts.map(a => a.exact)).toEqual([false, true]);
      expect(hits.map(hit => hit.slug)).toEqual(Array.from({ length: 10 }, (_, i) => `stale-wall-${300 + i}`));
      expect(events).toEqual([]);
    } finally {
      capability.vectorIterativeScan = previous;
    }
  }, 60_000);

  test('a short raw window holding stale rows escalates on the fresh count instead of stopping short', async () => {
    // 30,000 chunks along the e_3 arc; every 300th is type 'rare' (100 rows),
    // the nearest 90 rare rows stale. hnsw.max_scan_tuples (POOL_MAX_SCAN_TUPLES,
    // 20,000 per pooled attempt) cuts the filtered walk short. How far the walk
    // reaches varies with the randomized HNSW graph, so the only current rows
    // are the farthest 10: a short window holds fewer than 10 of them on any graph.
    await seedCluster('short-window', 30_000, [3, 4], 0.00002, i => ({
      type: i % 300 === 0 ? 'rare' : 'note', hash: i % 300 === 0 && i / 300 < 90 ? 'stale' : 'current',
    }));
    await engine.executeRaw('SET enable_seqscan = off');
    await engine.executeRaw('SET enable_sort = off');
    try {
      const attempts = spyAttempts();
      const events: PoolMeta[] = [];
      const hits = await engine.searchVector(axis(3), { limit: 10, type: 'rare', embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
      const first = attempts[0].batch!;
      expect(first.candidatePool).toBeLessThan(100);
      expect(first.eligiblePool!).toBeLessThan(10);
      expect(first.candidatePool).toBeGreaterThan(first.eligiblePool!);
      expect(attempts.length).toBeGreaterThan(1);
      expect(hits).toHaveLength(10);
      expect(hits.every(hit => Number(hit.slug.split('-').at(-1)) / 300 >= 90)).toBe(true);
    } finally {
      await engine.executeRaw('RESET enable_seqscan');
      await engine.executeRaw('RESET enable_sort');
    }
  }, 60_000);

  test('a source scope holding few chunks skips the walk: EXPLAIN and the first attempt run the scope scan through idx_chunks_page', async () => {
    await seedEngine.executeRaw(`INSERT INTO sources (id, name) VALUES ('tiny', 'tiny') ON CONFLICT (id) DO NOTHING`);
    await seedEngine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'tiny/n-' || i, 'tiny', 'note', 'Tiny ' || i, 'body', '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4
      FROM generate_series(0, 19) i`);
    await seedEngine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
      SELECT p.id, 0, 'tiny ' || p.id, 'compiled_truth', '${MODEL}', md5('tiny ' || p.id), e.v
      FROM pages p CROSS JOIN LATERAL (SELECT array_agg(random()::real - 0.5)::vector AS v FROM generate_series(1, ${DIM}) WHERE p.id > 0) e
      WHERE p.source_id = 'tiny'`);
    await seedEngine.executeRaw('ANALYZE pages');
    const opts: SearchOpts = { limit: 10, embeddingColumn: column, sourceId: 'tiny', excludePrivate: true };
    const [stats] = await engine.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL);
    const scope = sourceScope(stats, opts)!;
    expect(scope.share).toBeLessThan(INDEX_WALK_MIN_SCOPE_SHARE);
    expect(scope.chunks!).toBeLessThanOrEqual(SCOPE_SCAN_FIRST_MAX_CHUNKS);
    const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding: query, limit: 10, offset: 0, opts, scope });
    expect(stmt.indexWalkSql).toBeUndefined();
    expect(stmt.scopeScanSql).toBeDefined();

    const start = statements.length;
    const plan = await engine.explainVectorSearch(query, opts);
    const hits = await engine.searchVector(query, opts);
    const [explained, searched] = statements.slice(start);
    expect(explained.sql).toBe(`EXPLAIN (FORMAT JSON) ${stmt.scopeScanSql}`);
    expect(searched.sql).toBe(stmt.scopeScanSql!);
    expect(statements.slice(start).some(entry => entry.sql.includes('WITH ann AS MATERIALIZED'))).toBe(false);
    expect(JSON.stringify(plan)).toContain('"Index Name":"idx_chunks_page"');
    expect(scans(plan)).not.toMatch(/Seq Scan[^>]*content_chunks/);
    expect(hits).toHaveLength(10);
    expect(hits.every(hit => hit.source_id === 'tiny')).toBe(true);
  }, 60_000);
});
