/**
 * #6132 idea: under a selective source filter, pgvector's strict_order
 * iterative scan drops closer candidates it finds late, so filtered vector
 * search underfills its true neighbours; relaxed_order (the default now)
 * keeps them, and both engines re-sort after pooling. The fixture amplifies
 * the effect with a sparse HNSW graph (m = 4, ef_construction = 8) over 20k
 * clustered 32-dim vectors, a 10% source filter and exact truth computed in
 * process. HNSW construction is randomized, so the bounds sit about 0.1 away
 * from the measured ranges (strict 0.44-0.49, relaxed 0.68-0.75 over four
 * builds).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

const RUN = hasDatabase();
const D = 32, N = 20_000, K = 20, Q = 40;
const column = { name: 'embedding_iterative_fixture', type: 'vector' as const, dimensions: D, embeddingModel: '' };
let engine: PostgresEngine;
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const centers = Array.from({ length: 40 }, () => Array.from({ length: D }, gauss));
const vectors: number[][] = [];
const pageIds: number[] = [];
const allowed: boolean[] = [];

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return 1 - dot / Math.sqrt(na * nb);
}

async function meanRecall(mode?: 'strict_order' | 'relaxed_order'): Promise<number> {
  let qs = 9001;
  const qr = () => (qs = (qs * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const qg = () => Math.sqrt(-2 * Math.log(qr() + 1e-12)) * Math.cos(2 * Math.PI * qr());
  let total = 0;
  for (let qi = 0; qi < Q; qi++) {
    const q = centers[qi % centers.length]!.map((x) => x + qg() * 0.6);
    const truth = new Set(pageIds.map((id, i) => ({ id, d: cosineDistance(q, vectors[i]!), ok: allowed[i] }))
      .filter((r) => r.ok).sort((a, b) => a.d - b.d).slice(0, K).map((r) => r.id));
    const hits = await engine.searchVector(Float32Array.from(q), { sourceId: 'iter-allowed', limit: K, embeddingColumn: column, ...(mode ? { hnswIterativeScan: mode } : {}) });
    total += hits.filter((h) => truth.has(h.page_id)).length / K;
  }
  return total / Q;
}

describe.skipIf(!RUN)('filtered HNSW recall under iterative scan modes (Postgres, #6132)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('iter-allowed', 'iter-allowed'), ('iter-other', 'iter-other') ON CONFLICT DO NOTHING`);
    await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_iterative_fixture vector(${D})`);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'iter/p-' || i, CASE WHEN i % 10 = 0 THEN 'iter-allowed' ELSE 'iter-other' END, 'note', 'p' || i, 'fixture',
        '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4
      FROM generate_series(1, ${N}) i`);
    const pages = await engine.executeRaw<{ id: number; source_id: string }>(`SELECT id, source_id FROM pages WHERE slug LIKE 'iter/%' ORDER BY id`);
    const embeddings: string[] = [];
    for (const p of pages) {
      const v = centers[Math.floor(rnd() * centers.length)]!.map((x) => x + gauss() * 0.6);
      vectors.push(v);
      pageIds.push(Number(p.id));
      allowed.push(p.source_id === 'iter-allowed');
      embeddings.push(JSON.stringify(v));
    }
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, embedding_iterative_fixture)
      SELECT p, 0, 'fixture', 'compiled_truth', e::vector FROM unnest($1::int[], $2::text[]) u(p, e)`, [pageIds, embeddings]);
    await engine.transaction(async (tx) => {
      await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
      await tx.executeRaw(`CREATE INDEX idx_chunks_iterative_fixture ON content_chunks USING hnsw (embedding_iterative_fixture vector_cosine_ops) WITH (m = 4, ef_construction = 8)`);
    });
    await engine.executeRaw('ANALYZE content_chunks');
    await engine.executeRaw('ANALYZE pages');
    await refreshProjectionStatistics(engine);
  }, 300_000);

  afterAll(async () => {
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_iterative_fixture');
    await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_iterative_fixture');
    await teardownDB();
  }, 120_000);

  test('the default keeps the late, closer in-filter neighbours strict order drops', async () => {
    const byDefault = await meanRecall();
    const strict = await meanRecall('strict_order');
    expect(byDefault).toBeGreaterThanOrEqual(0.6);
    expect(byDefault - strict).toBeGreaterThanOrEqual(0.1);
  }, 300_000);
});
