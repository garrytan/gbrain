/**
 * v0.36 E2E (real Postgres) — halfvec + HNSW + doctor SQL probes.
 *
 * Skipped gracefully when DATABASE_URL is unset. When present, exercises
 * the real pgvector + Postgres code paths that PGLite can't fully cover:
 *
 *   - halfvec(2560) cast accepted by real pgvector via searchVector.
 *   - HNSW index on the alternative column is visible in EXPLAIN.
 *   - The format_type SQL the doctor check uses (D13) correctly distinguishes
 *     `vector(1024)` vs `vector(1536)` so dim drift can be detected.
 *   - The coverage SQL the doctor check uses (D14) computes accurate
 *     percentage and the < 90% gate fires when expected.
 *
 * Tests the SQL the doctor check issues, not `runDoctor` itself (which
 * calls process.exit). This is the regression-catching layer that
 * matters; the doctor wrapping just renders the result.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { quoteIdentifier } from '../../src/core/search/embedding-column.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  describe.skip('postgres E2E — embedding column (skipped: DATABASE_URL unset)', () => {
    test('skipped', () => { expect(true).toBe(true); });
  });
} else {
  let engine: PostgresEngine;
  let catId: number;
  let dogId: number;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: dbUrl } as never);
    await engine.initSchema();

    // Wipe state from prior runs.
    await engine.executeRaw(`DELETE FROM content_chunks`);
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'docs/%'`);

    // Add the ad-hoc Voyage + ZE columns + HNSW indexes.
    await engine.executeRaw(
      `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_voyage vector(1024)`,
    );
    await engine.executeRaw(
      `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_ze halfvec(2560)`,
    );
    await engine.executeRaw(
      `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_voyage
        ON content_chunks USING hnsw (embedding_voyage vector_cosine_ops)`,
    );

    // Seed two pages and two chunks.
    await engine.putPage('docs/cat', {
      type: 'concept',
      title: 'Cat doc',
      compiled_truth: 'Cat doc compiled truth.',
    });
    await engine.putPage('docs/dog', {
      type: 'concept',
      title: 'Dog doc',
      compiled_truth: 'Dog doc compiled truth.',
    });
    await engine.upsertChunks('docs/cat', [
      { chunk_index: 0, chunk_text: 'cat chunk', chunk_source: 'compiled_truth' },
    ]);
    await engine.upsertChunks('docs/dog', [
      { chunk_index: 0, chunk_text: 'dog chunk', chunk_source: 'compiled_truth' },
    ]);

    const idRows = await engine.executeRaw<{ id: number; slug: string }>(
      `SELECT cc.id, p.slug FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug LIKE 'docs/%' ORDER BY p.slug`,
    );
    catId = idRows.find(r => r.slug === 'docs/cat')!.id;
    dogId = idRows.find(r => r.slug === 'docs/dog')!.id;

    const vec1024 = (v: number) => `[${new Array(1024).fill(v).join(',')}]`;
    const vec2560 = (v: number) => `[${new Array(2560).fill(v).join(',')}]`;
    await engine.executeRaw(`UPDATE content_chunks SET embedding_voyage = '${vec1024(0.5)}'::vector WHERE id = ${catId}`);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_voyage = '${vec1024(0.7)}'::vector WHERE id = ${dogId}`);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_ze = '${vec2560(0.5)}'::halfvec WHERE id = ${catId}`);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_ze = '${vec2560(0.7)}'::halfvec WHERE id = ${dogId}`);
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  describe('Postgres: searchVector with halfvec descriptor', () => {
    test('halfvec(2560) cast accepted; results returned in expected cosine order', async () => {
      const queryVec = new Float32Array(2560).fill(0.5);
      const descriptor: ResolvedColumn = {
        name: 'embedding_ze',
        type: 'halfvec',
        dimensions: 2560,
        embeddingModel: 'zeroentropyai:zembed-1',
      };
      const results = await engine.searchVector(queryVec, {
        embeddingColumn: descriptor,
        limit: 5,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      // Cat's halfvec is identical to the query — closer than dog.
      expect(results[0].slug).toBe('docs/cat');
    });

    test('vector(1024) cast on embedding_voyage routes correctly', async () => {
      const queryVec = new Float32Array(1024).fill(0.5);
      const descriptor: ResolvedColumn = {
        name: 'embedding_voyage',
        type: 'vector',
        dimensions: 1024,
        embeddingModel: 'voyage:voyage-3-large',
      };
      const results = await engine.searchVector(queryVec, {
        embeddingColumn: descriptor,
        limit: 5,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].slug).toBe('docs/cat');
    });
  });

  describe('Postgres: HNSW index visible to planner', () => {
    test('pg_indexes shows the hnsw index on embedding_voyage', async () => {
      const rows = await engine.executeRaw<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'content_chunks'
            AND schemaname = 'public'`,
      );
      const voyageHnsw = rows.find(r =>
        r.indexname === 'idx_chunks_embedding_voyage' && /USING\s+hnsw/i.test(r.indexdef),
      );
      expect(voyageHnsw).toBeDefined();
      expect(voyageHnsw!.indexdef).toMatch(/embedding_voyage/);
    });
  });

  describe('Postgres: doctor SQL probes for dim drift (D13)', () => {
    test('format_type returns parenthesized dim — distinguishes vector(1024) from vector(1536)', async () => {
      // This is the exact SQL shape doctor's embedding_column_registry
      // check uses. If pg_attribute or format_type semantics ever change,
      // this test fails loud.
      const rows = await engine.executeRaw<{ attname: string; formatted: string }>(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS formatted
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'content_chunks'
            AND a.attname = ANY($1::text[])
            AND NOT a.attisdropped`,
        [['embedding', 'embedding_voyage', 'embedding_ze']],
      );
      const byName = new Map<string, string>();
      for (const r of rows) byName.set(r.attname, r.formatted);

      // Default 'embedding' is vector(1536) by committed schema.
      expect(byName.get('embedding')).toMatch(/^vector\(\d+\)/);
      // Voyage is vector(1024) per the ALTER above.
      expect(byName.get('embedding_voyage')).toBe('vector(1024)');
      // ZE is halfvec(2560) per the ALTER above.
      expect(byName.get('embedding_ze')).toBe('halfvec(2560)');
    });

    test('format_type catches dim drift: declared 1536 vs actual 1024', async () => {
      // Simulate the user declaring 1536 in their registry but the column
      // is actually 1024d. Doctor's regex-parse of the formatted string
      // is the layer that catches this.
      const rows = await engine.executeRaw<{ formatted: string }>(
        `SELECT format_type(atttypid, atttypmod) AS formatted
           FROM pg_attribute
          WHERE attrelid = 'content_chunks'::regclass
            AND attname = 'embedding_voyage'
            AND NOT attisdropped`,
      );
      const formatted = rows[0]?.formatted ?? '';
      const m = formatted.match(/^(vector|halfvec)\((\d+)\)$/);
      expect(m).toBeTruthy();
      const declaredDims = 1536;
      const actualDims = parseInt(m![2], 10);
      expect(actualDims).not.toBe(declaredDims); // The drift is detectable.
      expect(actualDims).toBe(1024);
    });
  });

  describe('Postgres: doctor SQL probe for coverage (D14)', () => {
    test('coverage % computed correctly on fully-populated column', async () => {
      const col = quoteIdentifier('embedding_voyage');
      const rows = await engine.executeRaw<{ pct: number; total: number }>(
        `SELECT (
           COUNT(*) FILTER (WHERE ${col} IS NOT NULL)::float
           / NULLIF(COUNT(*), 0) * 100
         )::float AS pct,
         COUNT(*)::int AS total
         FROM content_chunks`,
      );
      expect(rows[0].total).toBe(2);
      expect(rows[0].pct).toBe(100);
    });

    test('coverage % drops to 50 after a partial wipe; gate at < 90 fires', async () => {
      // Clear voyage on one chunk to simulate partial backfill.
      await engine.executeRaw(`UPDATE content_chunks SET embedding_voyage = NULL WHERE id = ${dogId}`);

      const col = quoteIdentifier('embedding_voyage');
      const rows = await engine.executeRaw<{ pct: number; total: number }>(
        `SELECT (
           COUNT(*) FILTER (WHERE ${col} IS NOT NULL)::float
           / NULLIF(COUNT(*), 0) * 100
         )::float AS pct,
         COUNT(*)::int AS total
         FROM content_chunks`,
      );
      expect(rows[0].total).toBe(2);
      expect(rows[0].pct).toBe(50);
      // The < 90 gate that doctor + config-set use should fire.
      expect(rows[0].pct < 90).toBe(true);

      // Restore so subsequent tests see the original fixture.
      const v = `[${new Array(1024).fill(0.7).join(',')}]`;
      await engine.executeRaw(`UPDATE content_chunks SET embedding_voyage = '${v}'::vector WHERE id = ${dogId}`);
    });
  });
}
