/**
 * The vector index walk (`indexWalkSql`) returns exactly what the joined
 * candidate statement returns whenever its window is full, and searchVector
 * falls back to the joined statement when page filters leave the walk short.
 *
 * Fixture (PGLite, 8-dim): three sources (one archived), five page types,
 * pages that the private-page rule hides (explicit `visibility: private`,
 * atoms, synthesized concepts, `derived_from` a private page), quarantined
 * and soft-deleted pages, stale chunk hashes, and three chunks per page. Both
 * statements run with index scans disabled, so each computes its window
 * exactly and the comparison is row-for-row, order included. The Postgres
 * plan proof is test/e2e/vector-plan-real-column-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../src/core/types.ts';

const MODEL = 'test:vector-index-walk';
const DIM = 8;
const column = { name: 'embedding', type: 'vector' as const, dimensions: DIM, embeddingModel: MODEL };
const PAGES = 600;

let engine: PGLiteEngine;

function vec(seed: number): Float32Array {
  return Float32Array.from({ length: DIM }, (_, d) => Math.sin(seed * (d + 1) * 0.37 + d));
}

/** Rows a statement returns with its window computed exactly (no index scans). */
async function exactRows(sql: string, params: unknown[]) {
  await engine.executeRaw('SET enable_indexscan = off');
  try {
    return await engine.executeRaw<Record<string, unknown>>(sql, params);
  } finally {
    await engine.executeRaw('RESET enable_indexscan');
  }
}

const shape = (rows: Record<string, unknown>[]) => rows.filter(row => row.page_id != null)
  .map(row => [row.slug, row.source_id, row.chunk_id, Number(row.score).toFixed(9)]);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
  await engine.executeRaw(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${DIM})`);
  await engine.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('side', 'side'), ('gone', 'gone') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'gone'`);
  // Page i sits in block i / 20, which sets its source; inside a block,
  // offsets 0-3 are hidden from remote readers by four private-page rules
  // (offset 3 is `derived_from` offset 0 of the same block and source).
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version, deleted_at)
    SELECT 'notes/n-' || i,
      CASE WHEN (i / 20) % 5 = 0 THEN 'side' WHEN (i / 20) % 7 = 3 THEN 'gone' ELSE 'default' END,
      CASE WHEN i % 20 = 1 THEN 'atom' WHEN i % 20 = 2 THEN 'concept' ELSE (ARRAY['note', 'person', 'company', 'meeting', 'note'])[1 + i % 5] END,
      'Note ' || i, 'body',
      CASE WHEN i % 20 = 0 THEN '{"visibility": "private"}'::jsonb
        WHEN i % 20 = 2 THEN '{"synthesized_by": "dream"}'::jsonb
        WHEN i % 20 = 3 THEN jsonb_build_object('derived_from', 'notes/n-' || (i - 3))
        WHEN i % 31 = 0 THEN '{"quarantine": {"reason": "junk_pattern"}}'::jsonb
        ELSE '{}'::jsonb END,
      '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4,
      CASE WHEN i % 37 = 0 THEN now() END
    FROM generate_series(0, ${PAGES - 1}) i`);
  const pages = await engine.executeRaw<{ id: number; slug: string }>(`SELECT id, slug FROM pages ORDER BY id`);
  const ids: number[] = [], idx: number[] = [], texts: string[] = [], hashes: (string | null)[] = [], vectors: string[] = [];
  for (const page of pages) {
    const n = Number(page.slug.split('-').at(-1));
    for (let c = 0; c < 3; c++) {
      ids.push(page.id); idx.push(c);
      texts.push(`chunk ${n} ${c}`);
      hashes.push(n % 13 === 0 && c === 0 ? 'stale-hash' : null);
      vectors.push(`[${Array.from(vec(n * 3 + c)).join(',')}]`);
    }
  }
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
    SELECT u.page_id, u.ci, u.t, 'compiled_truth', $6, COALESCE(u.h, md5(u.t)), u.v::vector
    FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[]) AS u(page_id, ci, t, h, v)`, [ids, idx, texts, hashes, vectors, MODEL]);
  await engine.executeRaw('ANALYZE');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('vector index walk (PGLite)', () => {
  const matrix: Array<[string, SearchOpts]> = [
    ['default scope', {}],
    ['remote reader (private-page rule)', { excludePrivate: true }],
    ['remote reader, limit 50', { excludePrivate: true, limit: 50 }],
    ['granted sources', { excludePrivate: true, sourceIds: ['default', 'side'] }],
    ['slug exclusion', { exclude_slugs: ['notes/n-5', 'notes/n-6'] }],
    ['compiled truth only', { detail: 'low', excludePrivate: true }],
  ];

  for (const [label, opts] of matrix) {
    test(`${label}: a full walk window returns the joined statement's rows in the same order`, async () => {
      for (const seed of [11, 202, 3003]) {
        const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(seed), limit: opts.limit ?? 20, offset: 0, opts: { embeddingColumn: column, ...opts } });
        expect(stmt.indexWalkSql).toBeDefined();
        const params = [...stmt.params];
        const walked = await exactRows(stmt.indexWalkSql!, params);
        const joined = await exactRows(stmt.sql, params);
        expect(Number(walked[0].candidate_pool)).toBe(stmt.innerLimit);
        expect(shape(walked).length).toBe(opts.limit ?? 20);
        expect(shape(walked)).toEqual(shape(joined));
        expect([walked[0].candidate_pool, walked[0].eligible_pool]).toEqual([joined[0].candidate_pool, joined[0].eligible_pool]);
      }
    });
  }

  test('the walk keeps every page filter: no hidden, deleted, archived or out-of-scope page reaches results', async () => {
    const hits = await engine.searchVector(vec(42), { limit: 50, embeddingColumn: column, excludePrivate: true, sourceIds: ['default', 'side'] });
    expect(hits).toHaveLength(50);
    for (const hit of hits) {
      const n = Number(hit.slug.split('-').at(-1));
      expect([0, 1, 2, 3]).not.toContain(n % 20);
      expect(n % 37 === 0 || n % 31 === 0 || hit.source_id === 'gone').toBe(false);
    }
  });

  test('a selective filter leaves the walk short and searchVector returns the joined statement result', async () => {
    const opts: SearchOpts = { limit: 10, embeddingColumn: column, sourceId: 'side', excludePrivate: true };
    const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding: vec(7), limit: 10, offset: 0, opts });
    const walked = await exactRows(stmt.indexWalkSql!, [...stmt.params]);
    expect(Number(walked[0].candidate_pool)).toBeLessThan(stmt.innerLimit);
    const joined = await exactRows(stmt.sql, [...stmt.params]);
    await engine.executeRaw('SET enable_indexscan = off');
    try {
      const hits = await engine.searchVector(vec(7), opts);
      expect(hits).toHaveLength(10);
      expect(hits.map(hit => hit.slug)).toEqual(shape(joined).map(row => String(row[0])));
    } finally {
      await engine.executeRaw('RESET enable_indexscan');
    }
  });
});
