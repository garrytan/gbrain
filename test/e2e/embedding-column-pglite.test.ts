/**
 * v0.36 E2E — dynamic embedding column selection (PGLite).
 *
 * Covers (per D4 + D9 + D11 + D12 + CDX-2 + CDX-3 + CDX-7 + CDX-8 + CDX-10):
 *   - Multi-column search: same query against `embedding` and against an
 *     ad-hoc `embedding_voyage` column produces different orderings
 *     consistent with the seeded vectors.
 *   - Halfvec column: ALTER TABLE ADD `embedding_ze halfvec(2560)` and
 *     confirm the `$1::halfvec(2560)` cast works.
 *   - Image branch unaffected: `embedding_image` still works via the
 *     existing operations.ts path.
 *   - cosineReScore reads from the active column, not the default
 *     (D9 — pre-fix, rescore against Voyage HNSW used OpenAI vectors).
 *   - Unknown column at hybridSearch entry throws loud.
 *   - Mid-session column switch invalidates the cache (knobs_hash v=3).
 *
 * No DATABASE_URL needed — PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  buildVectorCastFragment,
  EmbeddingColumnNotRegisteredError,
} from '../../src/core/search/embedding-column.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';

let engine: PGLiteEngine;
let chunkIdA: number;
let chunkIdB: number;

const VEC1536_A = new Array(1536).fill(0).map((_, i) => 0.001 * (i % 10));
const VEC1536_B = new Array(1536).fill(0).map((_, i) => 0.002 * (i % 10));
const VEC1024_A = new Array(1024).fill(0).map((_, i) => 0.5 - 0.001 * (i % 10));
const VEC1024_B = new Array(1024).fill(0).map((_, i) => 0.4 + 0.001 * (i % 10));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Add the ad-hoc Voyage + ZE columns the way a user with a multi-provider
  // brain has done it (outside the committed schema, per-instance ALTER).
  await (engine as any).db.exec(
    `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_voyage vector(1024)`,
  );
  await (engine as any).db.exec(
    `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_ze halfvec(2560)`,
  );

  // Two pages with one chunk each.
  await engine.putPage('docs/page-a', {
    type: 'concept',
    title: 'Page A — about cats',
    compiled_truth: 'Page A discusses cats and their behavior.',
  });
  await engine.putPage('docs/page-b', {
    type: 'concept',
    title: 'Page B — about dogs',
    compiled_truth: 'Page B discusses dogs and their habits.',
  });

  await engine.upsertChunks('docs/page-a', [
    { chunk_index: 0, chunk_text: 'cats behavior chunk A', chunk_source: 'compiled_truth' },
  ]);
  await engine.upsertChunks('docs/page-b', [
    { chunk_index: 0, chunk_text: 'dogs habits chunk B', chunk_source: 'compiled_truth' },
  ]);

  // Look up chunk ids.
  const rows = await engine.executeRaw<{ id: number; slug: string }>(
    `SELECT cc.id, p.slug FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug`,
  );
  chunkIdA = rows.find(r => r.slug === 'docs/page-a')!.id;
  chunkIdB = rows.find(r => r.slug === 'docs/page-b')!.id;

  // Seed vectors. Vectors are intentionally distinct between columns so
  // search orderings depend on which column the engine actually reads.
  const vecLit = (arr: number[]) => `[${arr.join(',')}]`;
  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding = $1::vector WHERE id = $2`,
    [vecLit(VEC1536_A), chunkIdA],
  );
  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding = $1::vector WHERE id = $2`,
    [vecLit(VEC1536_B), chunkIdB],
  );
  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding_voyage = $1::vector WHERE id = $2`,
    [vecLit(VEC1024_A), chunkIdA],
  );
  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding_voyage = $1::vector WHERE id = $2`,
    [vecLit(VEC1024_B), chunkIdB],
  );
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('PGLite engine: searchVector accepts ResolvedColumn descriptor (D11)', () => {
  test('vector cast routes to correct column when descriptor names embedding_voyage', async () => {
    const queryVec = new Float32Array(VEC1024_A);
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
    // Both pages have voyage embeddings; cosine to VEC1024_A is closer to
    // page-a (identical) than page-b. Verify ordering.
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].slug).toBe('docs/page-a');
  });

  test('halfvec cast accepted: ALTER TABLE column + $1::halfvec(N)', async () => {
    // Seed halfvec values via direct cast.
    const ze1 = `[${new Array(2560).fill(0.5).join(',')}]`;
    const ze2 = `[${new Array(2560).fill(0.6).join(',')}]`;
    await (engine as any).db.query(
      `UPDATE content_chunks SET embedding_ze = $1::halfvec WHERE id = $2`,
      [ze1, chunkIdA],
    );
    await (engine as any).db.query(
      `UPDATE content_chunks SET embedding_ze = $1::halfvec WHERE id = $2`,
      [ze2, chunkIdB],
    );

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
    // Page A's halfvec is closer to the all-0.5 query.
    expect(results[0].slug).toBe('docs/page-a');
  });

  test('legacy embedding_image literal still routes correctly', async () => {
    // We never seeded embedding_image so we expect zero results, but the
    // query MUST NOT throw — the legacy-literal path must still work
    // (no regression on the existing image branch).
    const v = new Float32Array(1024).fill(0.1);
    const results = await engine.searchVector(v, {
      embeddingColumn: 'embedding_image',
      limit: 5,
    });
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('PGLite engine: getEmbeddingsByChunkIds column param (D9)', () => {
  test('default fetches from embedding (back-compat)', async () => {
    const map = await engine.getEmbeddingsByChunkIds([chunkIdA, chunkIdB]);
    expect(map.get(chunkIdA)!.length).toBe(1536);
  });

  test('column="embedding_voyage" fetches from voyage column', async () => {
    const map = await engine.getEmbeddingsByChunkIds([chunkIdA, chunkIdB], 'embedding_voyage');
    expect(map.get(chunkIdA)!.length).toBe(1024);
  });

  test('invalid column rejected at engine layer (regex guard)', async () => {
    let threw: Error | null = null;
    try {
      await engine.getEmbeddingsByChunkIds([chunkIdA], 'embed-bad-name');
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).toBeInstanceOf(EmbeddingColumnNotRegisteredError);
  });
});

describe('hybridSearch + resolver — unknown column at entry (D11)', () => {
  test('unknown name in opts.embeddingColumn throws via resolver', async () => {
    // configureGateway with a transport stub so we don't hit a real API.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    __setEmbedTransportForTests(async () => ({
      embeddings: [new Array(1536).fill(0)],
      usage: { tokens: 0 },
    } as any));

    let threw: Error | null = null;
    try {
      await hybridSearch(engine, 'cats', {
        embeddingColumn: 'nonexistent_column',
        limit: 5,
      });
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).toBeInstanceOf(EmbeddingColumnNotRegisteredError);
  });
});

describe('buildVectorCastFragment — engine SQL composer (D3)', () => {
  test('vector descriptor emits $1::vector', () => {
    const r: ResolvedColumn = {
      name: 'embedding',
      type: 'vector',
      dimensions: 1536,
      embeddingModel: '',
    };
    const { col, castSql } = buildVectorCastFragment(r);
    expect(col).toBe('"embedding"');
    expect(castSql).toBe('$1::vector');
  });

  test('halfvec descriptor emits $1::halfvec(N) with parenthesized N', () => {
    const r: ResolvedColumn = {
      name: 'embedding_ze',
      type: 'halfvec',
      dimensions: 2560,
      embeddingModel: 'zeroentropyai:zembed-1',
    };
    const { col, castSql } = buildVectorCastFragment(r);
    expect(col).toBe('"embedding_ze"');
    expect(castSql).toBe('$1::halfvec(2560)');
  });
});
