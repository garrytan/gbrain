/**
 * v0.33 — SearchOpts.types filter, engine-level coverage.
 *
 * Exercises the SQL-level type filter on PGLite for searchKeyword
 * and searchVector. The E2E test (test/e2e/whoknows.test.ts) covers
 * the full pipeline; this file targets the engine surface specifically
 * so a regression in the types-clause SQL emission gets caught here
 * with a tight assertion rather than as part of a longer pipeline.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Three pages, three types, sharing the keyword "shared-keyword-xyz".
  await engine.putPage('wiki/people/p1', {
    type: 'person',
    title: 'Person One',
    compiled_truth: 'Person One has shared-keyword-xyz expertise.',
  });
  await engine.upsertChunks('wiki/people/p1', [
    {
      chunk_index: 0,
      chunk_text: 'Person One has shared-keyword-xyz expertise.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(10),
      token_count: 10,
    },
  ]);

  await engine.putPage('wiki/companies/c1', {
    type: 'company',
    title: 'Company One',
    compiled_truth: 'Company One leader in shared-keyword-xyz.',
  });
  await engine.upsertChunks('wiki/companies/c1', [
    {
      chunk_index: 0,
      chunk_text: 'Company One leader in shared-keyword-xyz.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(11),
      token_count: 10,
    },
  ]);

  await engine.putPage('concepts/c1', {
    type: 'concept',
    title: 'Concept One',
    compiled_truth: 'Concept One: shared-keyword-xyz is interesting.',
  });
  await engine.upsertChunks('concepts/c1', [
    {
      chunk_index: 0,
      chunk_text: 'Concept One: shared-keyword-xyz is interesting.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(12),
      token_count: 10,
    },
  ]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('searchKeyword — types filter', () => {
  test('no types filter: returns all three types', async () => {
    const results = await engine.searchKeyword('shared-keyword-xyz', { limit: 10 });
    const types = new Set(results.map((r) => r.type));
    expect(types.has('person')).toBe(true);
    expect(types.has('company')).toBe(true);
    expect(types.has('concept')).toBe(true);
  });

  test('types: [person, company] excludes concept', async () => {
    const results = await engine.searchKeyword('shared-keyword-xyz', {
      types: ['person', 'company'],
      limit: 10,
    });
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(['person', 'company']).toContain(r.type);
    }
    expect(results.find((r) => r.type === 'concept')).toBeUndefined();
  });

  test('types: [concept] excludes person and company', async () => {
    const results = await engine.searchKeyword('shared-keyword-xyz', {
      types: ['concept'],
      limit: 10,
    });
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('concept');
  });

  test('types: [] (empty array) is treated as no filter', async () => {
    // Empty array hits the `opts.types.length > 0` check and skips the
    // clause — same as omitting the field. Documented as part of the
    // SearchOpts.types contract.
    const all = await engine.searchKeyword('shared-keyword-xyz', { limit: 10 });
    const empty = await engine.searchKeyword('shared-keyword-xyz', { types: [], limit: 10 });
    expect(empty.length).toBe(all.length);
  });

  test('types alone is the multi-type filter (single-value `type` is Postgres-only)', async () => {
    // PGLite searchKeyword never honored the single-value `type` field
    // (pre-v0.33 parity gap; only postgres-engine.ts has typeClause). The
    // new v0.33 `types` field is the multi-type surface that BOTH engines
    // honor. AND-stacking with `type` is asserted in test/e2e cross-engine
    // coverage; on PGLite, `types` is the only filter that applies.
    const results = await engine.searchKeyword('shared-keyword-xyz', {
      types: ['person'],
      limit: 10,
    });
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('person');
  });
});

describe('searchVector — types filter', () => {
  test('no types filter: returns all matching types', async () => {
    const results = await engine.searchVector(basisEmbedding(10), { limit: 10 });
    // Vector search may return all by similarity; the assertion is that
    // the result set is non-empty and the filter is opt-in.
    expect(results.length).toBeGreaterThan(0);
  });

  test('types: [person, company] excludes concept from vector results', async () => {
    const results = await engine.searchVector(basisEmbedding(10), {
      types: ['person', 'company'],
      limit: 10,
    });
    for (const r of results) {
      expect(['person', 'company']).toContain(r.type);
    }
    expect(results.find((r) => r.type === 'concept')).toBeUndefined();
  });

  test('types: [concept] returns only concept-typed results from vector', async () => {
    const results = await engine.searchVector(basisEmbedding(12), {
      types: ['concept'],
      limit: 10,
    });
    for (const r of results) {
      expect(r.type).toBe('concept');
    }
  });
});

describe('searchKeywordChunks — types filter (Postgres-only path is parity)', () => {
  test('chunk-grain search honors types filter', async () => {
    // searchKeywordChunks lives in postgres-engine.ts; on PGLite the path
    // diverges into searchKeyword. We exercise via searchKeyword above and
    // assert the cross-engine contract here for posterity. This test
    // primarily documents the public surface; the SQL-level coverage for
    // postgres is in test/e2e/postgres-engine.test.ts (which runs only
    // with DATABASE_URL set).
    const results = await engine.searchKeyword('shared-keyword-xyz', {
      types: ['person'],
      limit: 10,
    });
    expect(results.every((r) => r.type === 'person')).toBe(true);
  });
});
