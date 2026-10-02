/**
 * #5824 correctness on PGLite: with content freshness filtered outside the
 * HNSW candidate CTE, a chunk whose text changed after embedding still never
 * reaches results, legacy NULL-hash chunks stay eligible, model mismatches
 * stay excluded, the pre-migration `$m IS NULL` branch is unchanged, and a
 * candidate window full of stale rows escalates instead of underfilling.
 * The Postgres side (plan proof, exact fallback) is
 * test/e2e/vector-plan-real-column-postgres.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import * as vectorPool from '../../src/core/search/vector-pool.ts';
import type { VectorPoolAttempt } from '../../src/core/search/vector-pool.ts';
import type { SearchOpts } from '../../src/core/types.ts';

const MODEL = 'test:vector-freshness';
const column = { name: 'embedding', type: 'vector' as const, dimensions: 8, embeddingModel: MODEL };
const query = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
type PoolMeta = Parameters<NonNullable<SearchOpts['onVectorPoolMeta']>>[0];

let engine: PGLiteEngine;
const originalPool = vectorPool.searchVectorPool;
let poolSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
  await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(8)');
  await engine.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  poolSpy?.mockRestore();
  poolSpy = undefined;
});

/** Pages `<prefix>-<i>`, one chunk each at angle `start + i * step` from the query. */
async function seed(prefix: string, count: number, start: number, step: number, chunk: { hash: 'current' | 'stale' | 'null'; model?: string }) {
  const hash = chunk.hash === 'current' ? 'md5(cc_text)' : chunk.hash === 'stale' ? `md5('text before the edit')` : 'NULL';
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
    SELECT '${prefix}-' || i, 'default', 'note', '${prefix} ' || i, 'fixture', '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid, 4
    FROM generate_series(0, ${count - 1}) i`);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
    SELECT id, 0, cc_text, 'compiled_truth', $1, ${hash}, ARRAY[cos(a), sin(a), 0, 0, 0, 0, 0, 0]::real[]::vector
    FROM (SELECT p.id, '${prefix} chunk text ' || p.slug AS cc_text,
            ${start} + (split_part(p.slug, '-', 2)::int) * ${step} AS a
          FROM pages p WHERE p.slug LIKE '${prefix}-%') src`, [chunk.model ?? MODEL]);
}

async function reset() {
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM config WHERE key = 'embedding_migration.state'`);
}

/** Records the `run` attempts searchVector hands to searchVectorPool. */
function spyAttempts(): VectorPoolAttempt[] {
  const attempts: VectorPoolAttempt[] = [];
  poolSpy = spyOn(vectorPool, 'searchVectorPool').mockImplementation((limit, initial, iterative, indexed, kind, run, hasMore, onMeta) =>
    originalPool(limit, initial, iterative, indexed, kind, async attempt => { attempts.push(attempt); return run(attempt); }, hasMore, onMeta));
  return attempts;
}

describe('vector freshness outside the candidate CTE (PGLite)', () => {
  test('stale, mismatched and NULL-hash chunks keep their exact eligibility', async () => {
    await reset();
    await seed('stale', 3, 0.001, 0.001, { hash: 'stale' });
    await seed('mismatch', 3, 0.002, 0.001, { hash: 'current', model: 'test:other-model' });
    await seed('legacy', 2, 0.01, 0.001, { hash: 'null' });
    await seed('fresh', 20, 0.05, 0.001, { hash: 'current' });
    for (const vectorLegacyGuard of [false, true]) {
      const hits = await engine.searchVector(query, { limit: 10, embeddingColumn: column, vectorLegacyGuard });
      const slugs = hits.map(hit => hit.slug);
      expect(slugs).toHaveLength(10);
      expect(slugs.slice(0, 2)).toEqual(['legacy-0', 'legacy-1']);
      expect(slugs.some(slug => slug.startsWith('stale-') || slug.startsWith('mismatch-'))).toBe(false);
    }
  }, 60_000);

  test('the pre-migration branch (no model, no migration state) is unchanged: every model and hash is eligible', async () => {
    await reset();
    await seed('stale', 2, 0.001, 0.001, { hash: 'stale' });
    await seed('mismatch', 2, 0.002, 0.001, { hash: 'current', model: 'test:other-model' });
    await seed('fresh', 10, 0.05, 0.001, { hash: 'current' });
    const preMigration = { ...column, embeddingModel: '' };
    const hits = await engine.searchVector(query, { limit: 4, embeddingColumn: preMigration });
    expect(hits.map(hit => hit.slug).sort()).toEqual(['mismatch-0', 'mismatch-1', 'stale-0', 'stale-1']);
    await engine.executeRaw(`INSERT INTO config (key, value) VALUES ('embedding_migration.state', '{}')`);
    expect(await engine.searchVector(query, { limit: 4, embeddingColumn: preMigration })).toEqual([]);
  }, 60_000);

  test('a candidate window full of stale chunks escalates and fills from current chunks', async () => {
    await reset();
    await seed('stale', 300, 0.0001, 0.0001, { hash: 'stale' });
    await seed('fresh', 30, 0.5, 0.001, { hash: 'current' });
    const attempts = spyAttempts();
    const events: PoolMeta[] = [];
    const hits = await engine.searchVector(query, { limit: 10, embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
    expect(hits.map(hit => hit.slug)).toEqual(Array.from({ length: 10 }, (_, i) => `fresh-${i}`));
    expect(attempts.map(attempt => attempt.innerLimit)).toEqual([100, 400]);
    expect(events).toEqual([]);

    const guarded = spyAttempts();
    const legacy = await engine.searchVector(query, { limit: 10, embeddingColumn: column, vectorLegacyGuard: true });
    expect(legacy.map(hit => hit.slug)).toEqual(hits.map(hit => hit.slug));
    expect(guarded.map(attempt => attempt.innerLimit)).toEqual([100]);
  }, 60_000);

  test('a stale wall beyond three escalations ends in the documented underfilled exit with only current chunks', async () => {
    await reset();
    await seed('stale', 6_500, 0.00001, 0.00001, { hash: 'stale' });
    await seed('fresh', 30, 0.5, 0.001, { hash: 'current' });
    const attempts = spyAttempts();
    const events: PoolMeta[] = [];
    const hits = await engine.searchVector(query, { limit: 10, embeddingColumn: column, onVectorPoolMeta: meta => events.push(meta) });
    expect(attempts.map(attempt => attempt.innerLimit)).toEqual([100, 400, 1_600, 6_400]);
    expect(hits).toEqual([]);
    expect(events).toEqual([{ underfilled: true, incomplete: true, reason: 'candidate_budget', escalations: 3, innerLimit: 6_400, candidatePool: 6_400, exactFallback: false }]);
  }, 120_000);
  test('since/until bounds keep the effective_date -> updated_at fallback and inclusivity', async () => {
    await reset();
    await seed('dated', 4, 0.01, 0.001, { hash: 'current' });
    await engine.executeRaw(`UPDATE pages SET effective_date = CASE slug
        WHEN 'dated-0' THEN '2024-01-10T00:00:00Z'::timestamptz WHEN 'dated-1' THEN NULL
        WHEN 'dated-2' THEN '2024-02-01T00:00:00Z'::timestamptz ELSE '2024-01-15T00:00:00Z'::timestamptz END,
      updated_at = CASE slug WHEN 'dated-1' THEN '2024-01-20T00:00:00Z'::timestamptz ELSE '2023-06-01T00:00:00Z'::timestamptz END`);
    const slugs = async (opts: SearchOpts) => (await engine.searchVector(query, { limit: 10, embeddingColumn: column, ...opts })).map(hit => hit.slug).sort();
    expect(await slugs({ afterDate: '2024-01-15T00:00:00Z' })).toEqual(['dated-1', 'dated-2']);
    expect(await slugs({ afterDate: '2024-01-15T00:00:00Z', afterDateInclusive: true })).toEqual(['dated-1', 'dated-2', 'dated-3']);
    expect(await slugs({ beforeDate: '2024-01-20T00:00:00Z' })).toEqual(['dated-0', 'dated-3']);
    expect(await slugs({ afterDate: '2024-01-12T00:00:00Z', beforeDate: '2024-01-20T00:00:00Z', beforeDateInclusive: true })).toEqual(['dated-1', 'dated-3']);
  }, 60_000);
});
