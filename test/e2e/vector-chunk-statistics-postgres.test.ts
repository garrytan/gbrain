/**
 * E5.4 plan proof: content_chunks planner statistics keep vector search on
 * its HNSW index. Without statistics on content_chunks, Postgres prices the
 * candidate statement's `cc.model = $m` and `cc.modality = 'text'` at 0.5%
 * each, expects a handful of eligible chunks and sorts every candidate by
 * distance instead of walking idx_chunks_embedding. At 1M to 2M chunks that
 * sort ran past the 8 s vector budget (docs/eval/hnsw-scale-bench.md).
 * Import, sync and reindex end with refreshProjectionStatistics, which used
 * to ANALYZE only pages(text_projection_revision, knowledge_revision). Both
 * halves of the fix are needed on this fixture: content_chunks(model,
 * modality, page_id) alone still sorts, because `p.deleted_at IS NULL` is
 * priced at 0.5% without pages statistics, and pages(deleted_at) alone still
 * sorts on the chunk filters. This proves the refresh now leaves the pooled
 * statement on the index.
 *
 *   1. precondition: with autovacuum off and nothing analyzed, the pooled
 *      statement does NOT use the index (an undersized fixture fails here);
 *   2. after refreshProjectionStatistics alone, it does.
 *
 * Runs in a dedicated 64-dim database with default planner costs, created on
 * the E2E server and dropped in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import { POOL_MAX_SCAN_TUPLES } from '../../src/core/search/vector-pool.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DIM = 64;
const MODEL = 'openai:text-embedding-3-small';
// 3,000 pages x 4 chunks, the size the #5824 plan proof measured as clear of
// the ANALYZEd flip point (about 2,000 chunks) on PostgreSQL 16 + pgvector 0.8.
const PAGES = 3_000;
const column = { name: 'embedding', type: 'vector' as const, dimensions: DIM, embeddingModel: MODEL };
const query = new Float32Array(DIM).map((_, i) => Math.sin(i * 1.7) * 0.5);

const adminUrl = process.env.GBRAIN_PGBOUNCER_DIRECT_URL ?? process.env.DATABASE_URL ?? '';
const dbName = `gbrain_test_chunk_stats_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine;

const usesIndex = (plan: unknown) => JSON.stringify(plan).includes('"Index Name":"idx_chunks_embedding"');
const scans = (plan: unknown) => JSON.stringify(plan).match(/"Node Type":"[^"]+"/g)?.join(' > ') ?? '';
type Run = (tx: { unsafe: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]> }, sql: string, bound: unknown[]) => Promise<Record<string, unknown>[]>;
/** EXPLAIN of the first pooled attempt searchVector runs after a rejected index walk: same statement, transaction and scan settings. */
async function pooledPlan(): Promise<unknown> {
  const opts = { limit: 50, embeddingColumn: column };
  const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding: query, limit: 50, offset: 0, opts });
  const attempt = { innerLimit: stmt.innerLimit, maxScanTuples: POOL_MAX_SCAN_TUPLES, remainingMs: 8_000, exact: false };
  const run = (engine as unknown as { runVectorAttempt: (s: unknown, a: unknown, i: boolean, o: unknown, r: Run) => Promise<Record<string, unknown>[]> }).runVectorAttempt;
  const [row] = await run.call(engine, stmt, attempt, true, opts, (tx, sql, bound) => tx.unsafe(`EXPLAIN (FORMAT JSON) ${sql}`, bound));
  return row?.['QUERY PLAN'];
}

(hasDatabase() ? describe : describe.skip)('content_chunks planner statistics keep the HNSW plan (Postgres)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    for (const [name, value] of [['random_page_cost', '4'], ['seq_page_cost', '1'], ['cpu_tuple_cost', '0.01'], ['cpu_index_tuple_cost', '0.005'],
      ['cpu_operator_cost', '0.0025'], ['effective_cache_size', "'4GB'"], ['max_parallel_workers_per_gather', '2'], ['jit', 'off']]) {
      await admin.unsafe(`ALTER DATABASE ${dbName} SET ${name} = ${value}`);
    }
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIM, env: {} });
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString(), poolSize: 2 });
    await engine.initSchema();
    for (const table of ['content_chunks', 'pages', 'sources']) await engine.executeRaw(`ALTER TABLE ${table} SET (autovacuum_enabled = off, toast.autovacuum_enabled = off)`);
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    await engine.executeRaw(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${DIM})`);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'notes/stats-' || i, 'default', 'note', 'Stats ' || i, 'fixture', '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid, 4
      FROM generate_series(1, ${PAGES}) i`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
      SELECT p.id, c, 'chunk ' || p.id || '/' || c, 'compiled_truth', '${MODEL}', md5('chunk ' || p.id || '/' || c),
        (SELECT array_agg(sin((p.id * 4 + c) * 0.37 + d * 1.13)::real ORDER BY d)::vector FROM generate_series(1, ${DIM}) d)
      FROM pages p CROSS JOIN generate_series(0, 3) c`);
    await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
      await tx.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
    });
  }, 180_000);

  afterAll(async () => {
    await engine?.disconnect();
    resetGateway();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);

  test('stats-less content_chunks sorts every candidate; the import/sync refresh restores the index plan', async () => {
    const [before] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stats WHERE tablename = 'content_chunks'`);
    expect(before!.n).toBe(0);
    const stale = await pooledPlan();
    expect(usesIndex(stale), `precondition: the stats-less pooled plan already uses the index (${scans(stale)}); grow PAGES`).toBe(false);

    expect(await refreshProjectionStatistics(engine)).toBe(true);
    const after = await engine.executeRaw<{ column: string }>(
      `SELECT tablename || '.' || attname AS column FROM pg_stats WHERE (tablename = 'content_chunks' AND attname IN ('model', 'modality', 'page_id'))
         OR (tablename = 'pages' AND attname = 'deleted_at') ORDER BY 1`);
    expect(after.map(r => r.column)).toEqual(['content_chunks.modality', 'content_chunks.model', 'content_chunks.page_id', 'pages.deleted_at']);
    const fresh = await pooledPlan();
    expect(usesIndex(fresh), scans(fresh)).toBe(true);
  }, 60_000);
});
