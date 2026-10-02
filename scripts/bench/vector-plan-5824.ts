#!/usr/bin/env bun
/**
 * #5824 reporter-scale vector-plan bench. Opt-in, never run in CI.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *     bun scripts/bench/vector-plan-5824.ts [--chunks 160000] [--dims 1536]
 *       [--queries 20] [--keep]
 *
 * Creates `gbrain_bench_vector_plan_<hex>` on the server DATABASE_URL points
 * at (the role needs CREATEDB and CREATE EXTENSION vector), seeds pages with
 * four chunks each (99.9% current `embedded_text_hash`, 0.1% legacy NULL),
 * vectors from a 16-dim latent tiled across the dimensions plus noise (so
 * nearest neighbours are well defined), builds the HNSW index, ANALYZEs, and measures "before" (the pre-fix
 * statement, reproduced by the legacy guard, which keeps the freshness guard
 * inside the candidate CTE) against "after" (the shipped statement) in four
 * phases:
 *
 *   current     reporter shape
 *   stale10     10% of chunks edited after embedding (hash mismatch)
 *   stale30     30% stale
 *   reembedded  the stale30 chunks re-embedded in place (what `gbrain embed
 *               --stale` does) with autovacuum off and no ANALYZE, so planner
 *               statistics still describe the pre-re-embed table
 *
 * Per phase and variant: whether EXPLAIN uses idx_chunks_embedding, searchVector
 * p50/p95 over N queries, the raw candidate count of the first attempt, the
 * escalation attempts, underfilled exits, and top-10 overlap against an exact
 * guarded scan. The current phase also runs hybridSearch (deterministic stub
 * embedder, no network) and reports whether it degraded with
 * vector_candidates_incomplete. Drops the database unless --keep.
 */
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { __setEmbedTransportForTests, configureGateway } from '../../src/core/ai/gateway.ts';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import { _resetVectorLegacyGuardForTests } from '../../src/core/search/vector-legacy-guard.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { SearchOpts } from '../../src/core/types.ts';

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

const CHUNKS = flag('chunks', 160_000);
const DIMS = flag('dims', 1536);
const QUERIES = flag('queries', 20);
// Real embeddings have low intrinsic dimension; uniform random 1536-dim vectors
// are all nearly equidistant, which makes any top-10 comparison noise. Each
// chunk is a random 16-dim latent tiled across the dimensions plus small noise.
const LATENT = 16;
const KEEP = process.argv.includes('--keep');
const MODEL = 'openai:text-embedding-3-large';
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('Set DATABASE_URL to a Postgres server where this role may CREATE DATABASE.');

const column = { name: 'embedding', type: 'vector' as const, dimensions: DIMS, embeddingModel: MODEL };
const pages = Math.ceil(CHUNKS / 4);
const dbName = `gbrain_bench_vector_plan_${randomBytes(6).toString('hex')}`;
const admin = postgres(adminUrl, { max: 1, prepare: false });
await admin.unsafe(`CREATE DATABASE ${dbName}`);
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'bench-stub-no-network' } });
const engine = new PostgresEngine();
await engine.connect({ database_url: url.toString(), poolSize: 2 });

const rows: string[][] = [];
const log = (message: string) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${message}`);

try {
  log(`seeding ${pages} pages x 4 chunks, ${DIMS} dims into ${dbName}`);
  await engine.initSchema();
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
    SELECT 'notes/n-' || i, 'default', 'note', 'Note ' || i, 'body ' || i, '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid, 4
    FROM generate_series(1, ${pages}) i`);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
    SELECT p.id, c, 'chunk ' || p.id || ' ' || c || ' lorem ipsum planner text', 'compiled_truth', '${MODEL}',
      CASE WHEN (p.id * 4 + c) % 1000 = 0 THEN NULL ELSE md5('chunk ' || p.id || ' ' || c || ' lorem ipsum planner text') END, e.v
    FROM pages p CROSS JOIN generate_series(0, 3) c
    CROSS JOIN LATERAL (SELECT array_agg(random()::real - 0.5) AS l FROM generate_series(1, ${LATENT}) WHERE p.id > 0 AND c >= 0) z
    CROSS JOIN LATERAL (SELECT array_agg(z.l[1 + (d - 1) % ${LATENT}] + (random()::real - 0.5) * 0.05 ORDER BY d)::vector AS v FROM generate_series(1, ${DIMS}) d) e`);
  await engine.executeRaw(`ALTER TABLE content_chunks SET (autovacuum_enabled = false)`);
  await engine.transaction(async tx => {
    await tx.executeRaw(`SET LOCAL maintenance_work_mem = '1GB'`);
    await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
    await tx.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
  });
  await engine.executeRaw('VACUUM ANALYZE content_chunks');
  await engine.executeRaw('ANALYZE pages');
  await engine.executeRaw('ANALYZE sources');
  await refreshProjectionStatistics(engine);

  // Queries near real rows (a stored embedding plus noise), like a real query near its answer.
  const seeds = await engine.executeRaw<{ v: string }>(`SELECT embedding::text AS v FROM content_chunks TABLESAMPLE SYSTEM (1) LIMIT ${QUERIES}`);
  const queries = seeds.map(({ v }) => Float32Array.from(JSON.parse(v) as number[], x => x + (Math.random() - 0.5) * 0.05));

  // Count ANN attempts and read each first attempt's raw candidate_pool off the wire.
  let attempts = 0, firstPool = 0;
  const scoped = engine as unknown as { withScopedReadTransaction: (...args: any[]) => Promise<any> };
  const scopedRead = scoped.withScopedReadTransaction;
  scoped.withScopedReadTransaction = function (sourceIds, sourceId, fn, options) {
    return scopedRead.call(this, sourceIds, sourceId, (tx: any) => fn(new Proxy(tx, {
      get(target, key) {
        if (key !== 'unsafe') return Reflect.get(target, key);
        return async (sql: string, params: unknown[]) => {
          const result = await target.unsafe(sql, params);
          if (sql.trimStart().startsWith('WITH hnsw_candidates') && attempts++ === 0) firstPool = Number(result[0]?.candidate_pool ?? 0);
          return result;
        };
      },
    })), options);
  };

  async function measure(phase: string) {
    for (const [variant, vectorLegacyGuard] of [['before', true], ['after', false]] as const) {
      const opts: SearchOpts = { limit: 10, embeddingColumn: column, vectorLegacyGuard };
      const plan = JSON.stringify(await engine.explainVectorSearch(queries[0], opts));
      const ms: number[] = [];
      let underfilled = 0, overlap = 0, poolTotal = 0, attemptsTotal = 0;
      for (const q of queries) {
        attempts = 0;
        firstPool = 0;
        const start = performance.now();
        const hits = await engine.searchVector(q, { ...opts, onVectorPoolMeta: meta => { if (meta.underfilled) underfilled++; } });
        ms.push(performance.now() - start);
        poolTotal += firstPool;
        attemptsTotal += attempts;
        const exact = buildVectorSearchStatement({ dialect: 'postgres', embedding: q, limit: 10, offset: 0, opts: { embeddingColumn: column } });
        const exactRows = await engine.transaction(async tx => {
          await tx.executeRaw(`SET LOCAL statement_timeout = '120s'`);
          const bound = [...exact.params];
          bound[exact.innerLimitIdx] = null;
          return tx.executeRaw<{ page_id: number | null }>(exact.exactSql, bound);
        });
        const exactIds = new Set(exactRows.filter(r => r.page_id != null).slice(0, 10).map(r => Number(r.page_id)));
        overlap += hits.slice(0, 10).filter(hit => exactIds.has(hit.page_id)).length / Math.max(1, exactIds.size);
      }
      ms.sort((a, b) => a - b);
      const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(0);
      rows.push([phase, variant, plan.includes('"Index Name":"idx_chunks_embedding"') ? 'yes' : 'no (seq scan)', pct(0.5), pct(0.95),
        (poolTotal / queries.length).toFixed(0), (attemptsTotal / queries.length).toFixed(2), String(underfilled), (overlap / queries.length).toFixed(2)]);
      log(`${phase}/${variant}: ${rows.at(-1)!.join(' | ')}`);
    }
  }

  async function hybrid() {
    const target = queries[0];
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => Array.from(target)), values, warnings: [], usage: { tokens: values.length },
    })) as never);
    const out: string[] = [];
    for (const [variant, guard] of [['before', '1'], ['after', '0']] as const) {
      process.env.GBRAIN_VECTOR_LEGACY_GUARD = guard;
      _resetVectorLegacyGuardForTests();
      let degraded: string[] = [];
      const start = performance.now();
      const results = await hybridSearch(engine, 'lorem ipsum planner text', { limit: 10, expansion: false,
        onMeta: meta => { degraded = (meta.degraded ?? []).map(entry => `${entry.stage}:${entry.reason}`); } });
      out.push(`| ${variant} | ${results.length} | ${(performance.now() - start).toFixed(0)} | ${degraded.filter(d => d.includes('vector')).join(', ') || 'none'} |`);
    }
    delete process.env.GBRAIN_VECTOR_LEGACY_GUARD;
    __setEmbedTransportForTests(null);
    return out;
  }

  await measure('current');
  const hybridRows = await hybrid();
  for (const [phase, fraction] of [['stale10', 0.1], ['stale30', 0.3]] as const) {
    await engine.executeRaw(`UPDATE content_chunks SET embedded_text_hash = md5('text before the edit')
      WHERE embedded_text_hash IS NOT NULL AND abs(hashtext(id::text)) % 1000 < ${Math.round(fraction * 1000)}`);
    await engine.executeRaw('ANALYZE content_chunks');
    await measure(phase);
  }
  // embed --stale: new vectors and current hashes for the stale rows, statistics left as they were.
  await engine.executeRaw(`UPDATE content_chunks SET embedded_text_hash = md5(chunk_text),
      embedding = (SELECT array_agg(z.l[1 + (d - 1) % ${LATENT}] + (random()::real - 0.5) * 0.05 ORDER BY d)::vector
        FROM (SELECT array_agg(random()::real - 0.5) AS l FROM generate_series(1, ${LATENT}) WHERE id > 0) z, generate_series(1, ${DIMS}) d)
    WHERE embedded_text_hash IS DISTINCT FROM md5(chunk_text) AND embedded_text_hash IS NOT NULL`);
  await measure('reembedded');

  const [versions] = await engine.executeRaw<{ pg: string; vector: string }>(
    `SELECT current_setting('server_version') AS pg, (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`);
  console.log(`\n#5824 vector plan bench: ${pages * 4} chunks, ${DIMS} dims, ${QUERIES} queries, PostgreSQL ${versions.pg}, pgvector ${versions.vector}\n`);
  console.log('| phase | variant | uses idx_chunks_embedding | p50 ms | p95 ms | first-attempt candidates | attempts/query | underfilled exits | top-10 overlap vs exact |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  console.log('\nHybrid query (current phase, stub embedder):\n\n| variant | results | ms | vector degradation |\n|---|---|---|---|');
  for (const row of hybridRows) console.log(row);
} finally {
  await engine.disconnect();
  if (!KEEP) await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  else log(`kept ${dbName}`);
  await admin.end();
}
