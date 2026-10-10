/**
 * Vector search recall across source-scope shares, on real-width (1024-dim,
 * TOASTed) vectors. Each scope's results are compared with the exact
 * statement (`exactSql`, no index, unbounded window) for the same query:
 *
 *   - scopes under SCOPE_SCAN_MAX_SHARE of pages run the exact scope scan
 *     first on this fixture, so their rows equal the exact statement's;
 *   - a scope clustered away from the query, sized as a mid-size scope, runs
 *     the walk first, comes back short and is answered by the scope scan;
 *   - wide scopes and unscoped searches keep the HNSW walk, held to a recall
 *     floor against the exact statement.
 *
 * Runs in a dedicated database created on the E2E server and dropped in
 * afterAll. The 50k-page benchmark that motivated the scope scan is in the
 * PR description; this fixture keeps the same statement paths at test size.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { buildVectorSearchStatement, PAGE_SOURCE_STATS_SQL, SCOPE_SCAN_FIRST_MAX_CHUNKS, sourceScope, type PageSourceStats, type VectorScope } from '../../src/core/search/vector-statement.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DIM = 1024;
const MODEL = 'voyage:voyage-4';
const PAGES = 2_000;
const TOPICS = 8;
const LIMIT = 20;
const QUERIES = 8;
const column = { name: 'embedding', type: 'vector' as const, dimensions: DIM, embeddingModel: MODEL };
/** Share buckets: source id and its share of pages (the rest stay in `default`). */
const BUCKETS: Array<[string, number]> = [['b0_1', 0.001], ['b1', 0.01], ['b4', 0.04], ['b8', 0.08], ['b16', 0.16], ['b50', 0.5]];
/** Pages of topic 0 that are moved to the clustered `topic` source. */
const TOPIC_SOURCE = 'topic';

const adminUrl = process.env.GBRAIN_PGBOUNCER_DIRECT_URL ?? process.env.DATABASE_URL ?? '';
const dbName = `gbrain_test_vector_recall_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine;
let queries: Float32Array[] = [];

/** Page ids of the exact statement's results: no index, every candidate ranked. */
async function exactPages(embedding: Float32Array, opts: SearchOpts): Promise<number[]> {
  const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding, limit: LIMIT, offset: 0, opts });
  const bound = [...stmt.params];
  bound[stmt.innerLimitIdx] = null;
  const rows = await engine.executeRaw<{ page_id: number | null }>(stmt.exactSql, bound);
  return rows.filter(row => row.page_id != null).map(row => Number(row.page_id));
}

async function recall(opts: SearchOpts): Promise<{ recall: number; identical: boolean }> {
  let hit = 0, total = 0, identical = true;
  for (const embedding of queries) {
    const truth = await exactPages(embedding, opts);
    const got = (await engine.searchVector(embedding, { ...opts, limit: LIMIT })).map(row => row.page_id);
    const truthSet = new Set(truth);
    total += truth.length;
    hit += got.filter(id => truthSet.has(id)).length;
    identical &&= JSON.stringify(got) === JSON.stringify(truth);
  }
  return { recall: hit / total, identical };
}

/** Which first attempts searchVector ran: 'walk', 'scan', or neither. */
async function firstAttempts(opts: SearchOpts): Promise<string[]> {
  const kinds: string[] = [];
  const original = vectorPool.searchIndexWalk;
  const spy = spyOn(vectorPool, 'searchIndexWalk').mockImplementation((stmt, limit, run) => original(stmt, limit, async attempt => {
    kinds.push(attempt.scopeScan ? 'scan' : attempt.indexWalk ? 'walk' : 'pool');
    return run(attempt);
  }));
  try {
    await engine.searchVector(queries[0]!, { ...opts, limit: LIMIT });
  } finally {
    spy.mockRestore();
  }
  return kinds;
}

(hasDatabase() ? describe : describe.skip)('vector search recall across source-scope shares (Postgres, 1024-dim)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.unsafe(`ALTER DATABASE ${dbName} SET jit = off`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIM, env: {} });
    const seed = new PostgresEngine();
    await seed.connect({ database_url: url.toString(), poolSize: 1 });
    await seed.initSchema();
    const sources = [...BUCKETS.map(([id]) => id), TOPIC_SOURCE];
    await seed.executeRaw(`SET session_replication_role = replica`);
    await seed.executeRaw(`INSERT INTO sources (id, name) SELECT s, s FROM unnest($1::text[]) s ON CONFLICT (id) DO NOTHING`, [sources]);
    // Page i: topic i % TOPICS; bucket sources take consecutive slices of a
    // page-id hash so they spread over every topic; topic-0 pages left in
    // `default` move to the clustered `topic` source.
    const cuts = BUCKETS.reduce<Array<[string, number]>>((acc, [id, share]) => [...acc, [id, (acc.at(-1)?.[1] ?? 0) + share]], []);
    const bucketCase = cuts.map(([id, upTo]) => `WHEN r.rank <= ${Math.round(upTo * PAGES)} THEN '${id}'`).join(' ');
    await seed.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'notes/n-' || r.i,
        CASE ${bucketCase} WHEN r.i % ${TOPICS} = 0 THEN '${TOPIC_SOURCE}' ELSE 'default' END,
        'note', 'Note ' || r.i, 'body', '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4
      FROM (SELECT i, row_number() OVER (ORDER BY md5(i::text)) AS rank FROM generate_series(0, ${PAGES - 1}) i) r`);
    await seed.executeRaw(`SELECT setseed(0.71)`);
    await seed.executeRaw(`CREATE TEMP TABLE topic_center AS SELECT t, array_agg(random() - 0.5 ORDER BY d)::real[] AS c FROM generate_series(0, ${TOPICS - 1}) t, generate_series(1, ${DIM}) d GROUP BY t`);
    await seed.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
      SELECT p.id, ci, 'chunk ' || p.id || ' ' || ci, 'compiled_truth', '${MODEL}', md5('chunk ' || p.id || ' ' || ci),
        (SELECT array_agg(tc.c[d] * 0.8 + (random() - 0.5) * 0.6 ORDER BY d)::real[]::vector FROM generate_series(1, ${DIM}) d WHERE p.id > 0 AND ci >= 0)
      FROM pages p JOIN topic_center tc ON tc.t = split_part(p.slug, '-', 2)::int % ${TOPICS}
      CROSS JOIN generate_series(0, 1) ci`);
    await seed.executeRaw(`SET session_replication_role = origin`);
    await seed.executeRaw('CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
    for (const table of ['content_chunks', 'pages', 'sources']) await seed.executeRaw(`ANALYZE ${table}`);
    // Queries: chunk vectors of topics 1..7 (never the clustered topic 0) plus noise.
    const rows = await seed.executeRaw<{ v: string }>(`SELECT cc.embedding::text AS v FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE split_part(p.slug, '-', 2)::int % ${TOPICS} <> 0 ORDER BY md5(cc.id::text) LIMIT ${QUERIES}`);
    queries = rows.map((row, k) => Float32Array.from(JSON.parse(row.v) as number[], (x, d) => x + Math.sin((k + 1) * (d + 1)) * 0.2));
    await seed.disconnect();
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString(), poolSize: 1 });
  }, 300_000);

  afterAll(async () => {
    await engine?.disconnect();
    resetGateway();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);

  test('the fixture spans the share buckets with TOASTed vectors', async () => {
    const [stats] = await engine.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL);
    for (const [id, share] of BUCKETS) expect(sourceScope(stats, { sourceId: id })!.share).toBeCloseTo(share, 2);
    const [toast] = await engine.executeRaw<{ external: boolean }>(`SELECT pg_column_size(embedding) < ${DIM * 4} OR pg_relation_size(reltoastrelid) > 0 AS external
      FROM content_chunks, pg_class WHERE pg_class.oid = 'content_chunks'::regclass LIMIT 1`);
    expect(toast.external).toBe(true);
  });

  for (const [id] of BUCKETS.filter(([, share]) => share < 0.5)) {
    test(`${id}: the scope scan runs first and returns the exact statement's pages, in order, for local and remote readers`, async () => {
      for (const extra of [{}, { excludePrivate: true }]) {
        const opts: SearchOpts = { embeddingColumn: column, sourceId: id, ...extra };
        expect(await firstAttempts(opts)).toEqual(['scan']);
        const result = await recall(opts);
        expect(result).toEqual({ recall: 1, identical: true });
      }
    }, 120_000);
  }

  test('a mid-size scope clustered away from the query: the walk comes back short and the scope scan answers exactly', async () => {
    const opts: SearchOpts = { embeddingColumn: column, sourceId: TOPIC_SOURCE };
    const scope = engine as unknown as { vectorScope: (opts?: SearchOpts) => Promise<VectorScope | undefined> };
    const original = scope.vectorScope;
    scope.vectorScope = async o => {
      const estimate = await original(o);
      return estimate && { share: 0.2, chunks: SCOPE_SCAN_FIRST_MAX_CHUNKS + 1 };
    };
    try {
      expect(await firstAttempts(opts)).toEqual(['walk', 'scan']);
      expect(await recall(opts)).toEqual({ recall: 1, identical: true });
    } finally {
      scope.vectorScope = original;
    }
  }, 120_000);

  for (const [label, opts] of [['b50 (walk)', { sourceId: 'b50' }], ['unscoped (walk)', {}]] as Array<[string, SearchOpts]>) {
    test(`${label}: the HNSW walk keeps recall against the exact statement`, async () => {
      const result = await recall({ embeddingColumn: column, ...opts });
      console.info(JSON.stringify({ metric: 'vector-scope-recall', scope: label, recall: result.recall }));
      expect(await firstAttempts({ embeddingColumn: column, ...opts })).toEqual(['walk']);
      expect(result.recall).toBeGreaterThanOrEqual(0.9);
    }, 120_000);
  }
});
