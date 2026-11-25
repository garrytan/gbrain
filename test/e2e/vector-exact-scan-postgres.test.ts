/**
 * search.vector_exact_max_chunks on real Postgres (search/vector-exact.ts).
 * A sparse HNSW graph (m = 4, ef_construction = 8) over 20k clustered 32-dim
 * vectors misses true neighbours, as gbrain's real index does on large
 * brains. With the exact ceiling covering the brain, searchVector must
 * return exactly the true nearest eligible pages (computed in process)
 * unfiltered, under a source filter and with private pages excluded, and no
 * row may break its filter. With the setting off, or a ceiling below the
 * brain's chunk count, results are the index path's, unchanged. An exact
 * scan the server cancels at its budget falls back to the index path, also
 * inside a caller's transaction.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { refreshProjectionStatistics } from '../../src/core/search/projection-statistics.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { vectorPlanCheck } from '../../src/commands/doctor/checks/vector-plan.ts';

const RUN = hasDatabase();
const D = 32, N = 20_000, K = 10, Q = 30;
const column = { name: 'embedding_exact_fixture', type: 'vector' as const, dimensions: D, embeddingModel: '' };
let engine: PostgresEngine;
let seed = 4242;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const centers = Array.from({ length: 40 }, () => Array.from({ length: D }, gauss));
interface Row { id: number; v: number[]; source: string; private: boolean }
const rows: Row[] = [];
const queries: number[][] = [];

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return 1 - dot / Math.sqrt(na * nb);
}

/** The exact answer: one chunk per page, no slug boosts on `exact/` slugs, so the K nearest eligible pages. */
function truth(q: number[], keep: (r: Row) => boolean): number[] {
  return rows.filter(keep).map(r => ({ id: r.id, d: cosineDistance(q, r.v) })).sort((a, b) => a.d - b.d).slice(0, K).map(r => r.id);
}

const search = (q: number[], opts: SearchOpts = {}, on = engine) =>
  on.searchVector(Float32Array.from(q), { limit: K, embeddingColumn: column, ...opts }).then(hits => hits.map(h => h.page_id));

async function recall(opts: SearchOpts, keep: (r: Row) => boolean): Promise<number> {
  let total = 0;
  for (const q of queries) {
    const want = new Set(truth(q, keep));
    total += (await search(q, opts)).filter(id => want.has(id)).length / K;
  }
  return total / queries.length;
}

describe.skipIf(!RUN)('exact vector scan under search.vector_exact_max_chunks (Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('exact-a', 'exact-a'), ('exact-b', 'exact-b') ON CONFLICT DO NOTHING`);
    await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_exact_fixture vector(${D})`);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'exact/p-' || i, CASE WHEN i % 10 = 0 THEN 'exact-a' ELSE 'exact-b' END, 'note', 'p' || i, 'fixture',
        CASE WHEN i % 7 = 0 THEN '{"visibility":"private"}'::jsonb ELSE '{}'::jsonb END,
        '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4
      FROM generate_series(1, ${N}) i`);
    const pages = await engine.executeRaw<{ id: number; source_id: string; private: boolean }>(
      `SELECT id, source_id, (frontmatter->>'visibility') = 'private' AS private FROM pages WHERE slug LIKE 'exact/%' ORDER BY id`);
    const embeddings: string[] = [];
    for (const p of pages) {
      const v = centers[Math.floor(rnd() * centers.length)]!.map(x => x + gauss() * 0.6);
      rows.push({ id: Number(p.id), v, source: p.source_id, private: !!p.private });
      embeddings.push(JSON.stringify(v));
    }
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, embedding_exact_fixture)
      SELECT p, 0, 'fixture', 'compiled_truth', e::vector FROM unnest($1::int[], $2::text[]) u(p, e)`, [rows.map(r => r.id), embeddings]);
    // A soft-deleted page sits at a query's exact position; no search may return it.
    const deletedVector = rows[1]!.v;
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [rows[1]!.id]);
    rows.splice(1, 1);
    await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL max_parallel_maintenance_workers = 0');
      await tx.executeRaw(`CREATE INDEX idx_chunks_exact_fixture ON content_chunks USING hnsw (embedding_exact_fixture vector_cosine_ops) WITH (m = 4, ef_construction = 8)`);
    });
    await engine.executeRaw('ANALYZE content_chunks');
    await engine.executeRaw('ANALYZE pages');
    await refreshProjectionStatistics(engine);
    let qs = 77;
    const qr = () => (qs = (qs * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const qg = () => Math.sqrt(-2 * Math.log(qr() + 1e-12)) * Math.cos(2 * Math.PI * qr());
    for (let i = 0; i < Q; i++) queries.push(centers[i % centers.length]!.map(x => x + qg() * 0.6));
    queries[0] = deletedVector.map(x => x + 1e-4); // the deleted page is this query's nearest neighbour
  }, 300_000);

  afterAll(async () => {
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_exact_fixture');
    await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_exact_fixture');
    await teardownDB();
  }, 120_000);

  const ON = { vectorExactMaxChunks: 1_000_000 };

  test('the index alone misses true neighbours on this fixture (the test can tell exact from index)', async () => {
    expect(await recall({}, () => true)).toBeLessThan(0.98);
  }, 120_000);

  test('setting on: every unfiltered search returns exactly the true nearest pages, in distance order', async () => {
    for (const q of queries) expect(await search(q, ON)).toEqual(truth(q, () => true));
  }, 120_000);

  test('setting on: a source filter returns exactly the true nearest pages of that source, none outside it', async () => {
    const inSource = new Set(rows.filter(r => r.source === 'exact-a').map(r => r.id));
    for (const q of queries) {
      const got = await search(q, { ...ON, sourceId: 'exact-a' });
      expect(got.every(id => inSource.has(id))).toBe(true);
      expect(got).toEqual(truth(q, r => r.source === 'exact-a'));
    }
  }, 120_000);

  test('setting on: excluded private pages and deleted pages never appear, and the rest is exact', async () => {
    const privateIds = new Set(rows.filter(r => r.private).map(r => r.id));
    const [deleted] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug LIKE 'exact/%' AND deleted_at IS NOT NULL`);
    for (const q of queries) {
      const got = await search(q, { ...ON, excludePrivate: true });
      expect(got.some(id => privateIds.has(id) || id === Number(deleted!.id))).toBe(false);
      expect(got).toEqual(truth(q, r => !r.private));
    }
  }, 120_000);

  test('setting off (0) or a ceiling below the chunk count keeps the index path results unchanged', async () => {
    for (const q of queries.slice(0, 10)) {
      const indexPath = await search(q);
      expect(await search(q, { vectorExactMaxChunks: 0 })).toEqual(indexPath);
      expect(await search(q, { vectorExactMaxChunks: 100 })).toEqual(indexPath);
    }
  }, 120_000);

  test('a server-cancelled exact scan falls back to the index path, also inside a caller transaction', async () => {
    // Every exact statement (`ORDER BY (distance) + 0`) is swapped for a sleep longer than its 2 s budget.
    const scoped = engine as unknown as { withScopedReadTransaction: (...args: any[]) => Promise<any> };
    const original = scoped.withScopedReadTransaction;
    const cancelled: string[] = [];
    scoped.withScopedReadTransaction = function (sourceIds, sourceId, fn, options) {
      return original.call(this, sourceIds, sourceId, (tx: any) => fn(new Proxy(tx, {
        get(target, key) {
          if (key !== 'unsafe') return Reflect.get(target, key);
          return (sql: string, params: unknown[]) => sql.includes(') + 0')
            ? target.unsafe('SELECT pg_sleep(30)').catch((error: { code?: string }) => { cancelled.push(String(error.code)); throw error; })
            : target.unsafe(sql, params);
        },
      })), options);
    };
    try {
      const q = queries[2]!;
      const started = performance.now();
      expect(await search(q, ON)).toEqual(await search(q));
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(cancelled).toEqual(['57014']);
      await engine.transaction(async tx => {
        const inTx = tx as unknown as PostgresEngine;
        expect(await search(q, ON, inTx)).toEqual(await search(q, {}, inTx));
        expect(await tx.executeRaw<{ one: number }>(`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
      });
      expect(cancelled).toEqual(['57014', '57014']);
    } finally {
      scoped.withScopedReadTransaction = original;
    }
  }, 120_000);

  test('doctor vector_plan reports the setting and says when it covers the brain', async () => {
    try {
      await engine.setConfig('search.vector_exact_max_chunks', '1000000');
      const on = await vectorPlanCheck(engine, { column });
      expect(on.details).toMatchObject({ exact_scan: { max_chunks: 1_000_000, via: 'config', applies: true } });
      expect(on.message).toContain('Exact vector scan is on for brains up to 1000000 chunks');
      await engine.setConfig('search.vector_exact_max_chunks', '100');
      const below = await vectorPlanCheck(engine, { column });
      expect(below.details).toMatchObject({ exact_scan: { max_chunks: 100, applies: false } });
      expect(below.message).not.toContain('Exact vector scan is on');
    } finally {
      await engine.unsetConfig('search.vector_exact_max_chunks');
    }
  }, 120_000);
});
