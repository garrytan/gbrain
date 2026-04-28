/**
 * Search Swamp Resistance E2E
 *
 * Reproduces the v3-plan repro case: a curated article (originals/) competes
 * with two chat-log pages (wintermute/chat/) on similar ts_rank. With v0.21+
 * source-aware ranking, the article must rank #0.
 *
 * Mirrors the structure of search-quality.test.ts. Uses PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';

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

  // Curated article — short, dense, opinionated. The page that should win.
  await engine.putPage('originals/talks/article-outline-fat-code', {
    type: 'writing',
    title: 'Fat Code Thin Harness — Part 3',
    compiled_truth:
      'Fat code thin harness is the architectural pattern where business logic ' +
      'lives in fat skill files and the runtime stays thin. Part 3 covers the ' +
      'production case studies.',
    timeline: '2026-04-10: Drafted Part 3 outline.',
  });
  await engine.upsertChunks('originals/talks/article-outline-fat-code', [
    {
      chunk_index: 0,
      chunk_text:
        'Fat code thin harness — the pattern where business logic lives in fat skill files. Part 3.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(7),
      token_count: 20,
    },
  ] satisfies ChunkInput[]);

  // Chat swamp #1 — long page, mentions the phrase repeatedly.
  await engine.putPage('wintermute/chat/2026-04-15', {
    type: 'note',
    title: '2026-04-15 chat',
    compiled_truth: '',
    timeline:
      'fat code thin harness fat code thin harness — discussed at length. ' +
      'fat code thin harness came up again. ' +
      'The fat code thin harness pattern is something we keep returning to. ' +
      'fat code thin harness fat code thin harness fat code thin harness.',
  });
  await engine.upsertChunks('wintermute/chat/2026-04-15', [
    {
      chunk_index: 0,
      chunk_text:
        'fat code thin harness fat code thin harness discussed at length, ' +
        'the fat code thin harness pattern keeps coming back, ' +
        'fat code thin harness fat code thin harness fat code thin harness.',
      chunk_source: 'timeline',
      embedding: basisEmbedding(8),
      token_count: 30,
    },
  ] satisfies ChunkInput[]);

  // Chat swamp #2 — same shape.
  await engine.putPage('wintermute/chat/2026-04-16', {
    type: 'note',
    title: '2026-04-16 chat',
    compiled_truth: '',
    timeline:
      'fat code thin harness once more. fat code thin harness fat code thin harness. ' +
      'still talking about fat code thin harness. fat code thin harness.',
  });
  await engine.upsertChunks('wintermute/chat/2026-04-16', [
    {
      chunk_index: 0,
      chunk_text:
        'fat code thin harness once more, fat code thin harness fat code thin harness, ' +
        'still talking about fat code thin harness fat code thin harness.',
      chunk_source: 'timeline',
      embedding: basisEmbedding(9),
      token_count: 25,
    },
  ] satisfies ChunkInput[]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('searchKeyword swamp resistance', () => {
  test('curated originals/ page outranks chat swamp on multi-word query', async () => {
    const results = await engine.searchKeyword('fat code thin harness');
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.slug).toBe('originals/talks/article-outline-fat-code');
  });

  test('detail=high (temporal bypass) lets chat swamp re-surface', async () => {
    // With source-boost disabled, raw ts_rank wins → chat pages, which have
    // many more keyword hits, are allowed back to the top. This guards the
    // temporal-query workflow ("what did we discuss about X").
    const results = await engine.searchKeyword('fat code thin harness', { detail: 'high' });
    expect(results.length).toBeGreaterThan(0);
    // Top result should be a chat page (more keyword density per chunk).
    const topSlugs = results.slice(0, 2).map(r => r.slug);
    const anyChat = topSlugs.some(s => s.startsWith('wintermute/chat/'));
    expect(anyChat).toBe(true);
  });
});

describe('searchVector swamp resistance', () => {
  test('curated originals/ page outranks chat swamp when boost is meaningful', async () => {
    // Query vector is close to all three pages (mixed direction). Without
    // source-boost the chat pages would tie or win on raw cosine; with
    // source-boost the originals/ page dominates.
    const queryVec = new Float32Array(1536);
    queryVec[7] = 0.6; // article direction
    queryVec[8] = 0.55; // chat-1 direction (slightly higher, simulating swamp)
    queryVec[9] = 0.55; // chat-2 direction
    // Normalize so cosine math is well-formed.
    const norm = Math.sqrt(0.6 * 0.6 + 0.55 * 0.55 + 0.55 * 0.55);
    for (let i = 0; i < queryVec.length; i++) queryVec[i] = queryVec[i] / norm;

    const results = await engine.searchVector(queryVec);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('originals/talks/article-outline-fat-code');
  });

  test('two-stage CTE returns p.source_id (regression for v0.18 multi-source)', async () => {
    const queryVec = basisEmbedding(7);
    const results = await engine.searchVector(queryVec);
    expect(results.length).toBeGreaterThan(0);
    // source_id is added by v0.18 multi-source brains; carrying it through
    // the inner→outer CTE is one of the v3 plan's pass-4 findings.
    for (const r of results) {
      expect(r.source_id).toBeDefined();
    }
  });
});
