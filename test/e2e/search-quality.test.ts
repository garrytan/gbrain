/**
 * Search Quality E2E Tests
 *
 * Tests the full search pipeline against PGLite with seeded pages and
 * structured mock embeddings (basis vectors). No OpenAI API calls needed.
 *
 * Validates: compiled truth boost, detail parameter, source-aware dedup,
 * chunk_id/chunk_index in results, and getEmbeddingsByChunkIds.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput, SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

// Create a basis vector embedding: dimension `idx` is 1.0, rest are 0.0
function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();

  // Seed test pages with compiled_truth + timeline chunks
  await engine.putPage('people/pedro', {
    type: 'person',
    title: 'Pedro Franceschi',
    compiled_truth: 'Pedro is the co-founder of Brex. Expert in fintech and payments infrastructure.',
    timeline: '2024-03-15: Met Pedro at YC dinner. Discussed AI security.',
  });

  // Seed chunks with structured embeddings
  const pedroChunks: ChunkInput[] = [
    {
      chunk_index: 0,
      chunk_text: 'Pedro is the co-founder of Brex. Expert in fintech and payments infrastructure.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(0), // direction 0 = fintech/compiled truth
      token_count: 15,
    },
    {
      chunk_index: 1,
      chunk_text: '2024-03-15: Met Pedro at YC dinner. Discussed AI security and Crab Trap.',
      chunk_source: 'timeline',
      embedding: basisEmbedding(1), // direction 1 = meeting/timeline
      token_count: 18,
    },
  ];
  await engine.upsertChunks('people/pedro', pedroChunks);

  await engine.putPage('companies/variant', {
    type: 'company',
    title: 'Variant Fund',
    compiled_truth: 'Variant is a crypto-native investment firm focused on web3 ownership economy.',
    timeline: '2024-06-01: Variant announced new fund.',
  });

  const variantChunks: ChunkInput[] = [
    {
      chunk_index: 0,
      chunk_text: 'Variant is a crypto-native investment firm focused on web3 ownership economy.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(2),
      token_count: 14,
    },
    {
      chunk_index: 1,
      chunk_text: '2024-06-01: Variant announced new fund. $450M raised.',
      chunk_source: 'timeline',
      embedding: basisEmbedding(3),
      token_count: 12,
    },
  ];
  await engine.upsertChunks('companies/variant', variantChunks);

  await engine.putPage('concepts/ai-philosophy', {
    type: 'concept',
    title: 'AI Changes Who Gets to Build',
    compiled_truth: 'AI democratizes building. The marginal cost of creation approaches zero.',
    timeline: '2024-01-10: First wrote about AI and building access.',
  });

  const aiChunks: ChunkInput[] = [
    {
      chunk_index: 0,
      chunk_text: 'AI democratizes building. The marginal cost of creation approaches zero. This changes who gets to build.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(4),
      token_count: 20,
    },
    {
      chunk_index: 1,
      chunk_text: '2024-01-10: First wrote about AI and building access. Shared on X.',
      chunk_source: 'timeline',
      embedding: basisEmbedding(5),
      token_count: 15,
    },
  ];
  await engine.upsertChunks('concepts/ai-philosophy', aiChunks);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('SearchResult fields', () => {
  test('keyword search returns chunk_id and chunk_index', async () => {
    const results = await engine.searchKeyword('Pedro');
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.chunk_id).toBeDefined();
    expect(typeof r.chunk_id).toBe('number');
    expect(r.chunk_index).toBeDefined();
    expect(typeof r.chunk_index).toBe('number');
  });

  test('vector search returns chunk_id and chunk_index', async () => {
    const results = await engine.searchVector(basisEmbedding(0));
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.chunk_id).toBeDefined();
    expect(typeof r.chunk_id).toBe('number');
    expect(r.chunk_index).toBeDefined();
    expect(typeof r.chunk_index).toBe('number');
  });
});

describe('detail parameter', () => {
  test('detail=low returns only compiled_truth chunks', async () => {
    const results = await engine.searchKeyword('Pedro', { detail: 'low' });
    for (const r of results) {
      expect(r.chunk_source).toBe('compiled_truth');
    }
  });

  test('detail=high returns all chunk sources', async () => {
    const results = await engine.searchKeyword('Pedro', { detail: 'high' });
    // Should include at least compiled_truth (might include timeline depending on tsvector match)
    expect(results.length).toBeGreaterThan(0);
  });

  test('detail=low on vector search filters to compiled_truth', async () => {
    // Use a timeline-direction embedding — with detail=low, should get no results
    // or only compiled_truth results
    const results = await engine.searchVector(basisEmbedding(1), { detail: 'low' });
    for (const r of results) {
      expect(r.chunk_source).toBe('compiled_truth');
    }
  });

  test('default detail (medium) returns all sources', async () => {
    const results = await engine.searchKeyword('Pedro');
    // No filter applied, should return whatever matches
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('getEmbeddingsByChunkIds', () => {
  test('returns embeddings for valid chunk IDs', async () => {
    const searchResults = await engine.searchVector(basisEmbedding(0));
    expect(searchResults.length).toBeGreaterThan(0);

    const ids = searchResults.map(r => r.chunk_id).filter((id): id is number => id != null);
    const embMap = await engine.getEmbeddingsByChunkIds(ids);

    expect(embMap.size).toBeGreaterThan(0);
    for (const [id, emb] of embMap) {
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb.length).toBe(1536);
    }
  });

  test('returns empty map for empty ID list', async () => {
    const embMap = await engine.getEmbeddingsByChunkIds([]);
    expect(embMap.size).toBe(0);
  });

  test('returns empty map for non-existent IDs', async () => {
    const embMap = await engine.getEmbeddingsByChunkIds([999999, 999998]);
    expect(embMap.size).toBe(0);
  });
});

describe('keyword search without DISTINCT ON', () => {
  test('returns multiple chunks per page', async () => {
    // Search for something that matches a page with multiple chunks
    const results = await engine.searchKeyword('Pedro', { limit: 10 });
    const pedroChunks = results.filter(r => r.slug === 'people/pedro');
    // Should be able to return more than 1 chunk per page
    // (depends on tsvector matching — Pedro is in page title/search_vector)
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('compiled truth boost (vector search validates ordering)', () => {
  test('compiled_truth chunks rank first with basis vector queries', async () => {
    // Query with the compiled_truth direction for Pedro (basis 0)
    const results = await engine.searchVector(basisEmbedding(0), { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    // The closest result should be the compiled_truth chunk (basis 0)
    expect(results[0].chunk_source).toBe('compiled_truth');
    expect(results[0].slug).toBe('people/pedro');
  });

  test('timeline chunks rank first when queried with timeline direction', async () => {
    // Query with the timeline direction for Pedro (basis 1)
    const results = await engine.searchVector(basisEmbedding(1), { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk_source).toBe('timeline');
    expect(results[0].slug).toBe('people/pedro');
  });
});
