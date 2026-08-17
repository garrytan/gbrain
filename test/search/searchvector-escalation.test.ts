/**
 * v0.46.15 — searchVector bounded pagination escalation (retrieval-cathedral
 * P1, outside-voice R2-10).
 *
 * The bug: innerLimit counted CHUNKS before the best-per-page DISTINCT
 * collapse. One dense page with 100+ strong chunks consumed the entire
 * candidate pool, so the PAGE result came back underfilled — sparse pages
 * behind the dense one were unreachable at any limit.
 *
 * The fix: escalate innerLimit ×4 (≤3 times, hard-capped at the HNSW
 * ef_search substrate ceiling of 1000) while the page set is short but the
 * pre-collapse candidate pool was FULL. A short page with a non-full pool is
 * a genuine final page — no retry. Exhaustion at the cap emits
 * onVectorPoolMeta (visible, not silent).
 *
 * PGLite side of the engine-parity pair; the postgres side is pinned by
 * test/e2e/engine-parity.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import type { ChunkInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

const DIM = 1536;

/** Unit vector with cosine-similarity `cos` against basis direction 0. */
function gradedEmb(cos: number, otherDim: number): Float32Array {
  const e = new Float32Array(DIM);
  e[0] = cos;
  e[otherDim % DIM] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return e;
}

function basisEmbedding(idx: number): Float32Array {
  const e = new Float32Array(DIM);
  e[idx % DIM] = 1.0;
  return e;
}

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { ...process.env },
  });
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();

  // Dense page: 120 chunks, all closer to the query than any sparse page.
  // Pre-fix, these 120 fill the 100-chunk inner pool alone → 1 result page.
  await engine.putPage('notes/dense', {
    type: 'note',
    title: 'Dense Page',
    compiled_truth: 'dense.',
  });
  const denseChunks: ChunkInput[] = Array.from({ length: 120 }, (_, i) => ({
    chunk_index: i,
    chunk_text: `dense chunk ${i}`,
    chunk_source: 'compiled_truth' as const,
    embedding: gradedEmb(0.99 - i * 0.0005, 10 + i),
    token_count: 3,
  }));
  await engine.upsertChunks('notes/dense', denseChunks);

  // 15 sparse pages, one weaker chunk each — reachable only past the dense wall.
  for (let p = 0; p < 15; p++) {
    const slug = `notes/sparse-${String(p).padStart(2, '0')}`;
    await engine.putPage(slug, { type: 'note', title: `Sparse ${p}`, compiled_truth: 'sparse.' });
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: `sparse ${p}`,
        chunk_source: 'compiled_truth',
        embedding: gradedEmb(0.6 - p * 0.001, 400 + p),
        token_count: 2,
      },
    ]);
  }
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('searchVector bounded escalation', () => {
  test('a dense page can no longer starve the page result (escalates past the chunk wall)', async () => {
    const results = await engine.searchVector(basisEmbedding(0), { limit: 10, detail: 'high' });
    const slugs = results.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // per-page pooled — no dup pages
    expect(results.length).toBe(10); // pre-fix: 1 (the dense page only)
    expect(slugs[0]).toBe('notes/dense'); // strongest page still first
    expect(slugs.filter((s) => s.startsWith('notes/sparse-')).length).toBe(9);
  });

  test('a genuine short corpus does NOT escalate forever and emits nothing', async () => {
    const events: unknown[] = [];
    // limit far above what the corpus can yield (16 pages total): the pool
    // goes non-full at the first escalation that swallows the whole corpus,
    // and the loop stops WITHOUT an exhaustion event.
    const results = await engine.searchVector(basisEmbedding(0), {
      limit: 50,
      detail: 'high',
      onVectorPoolMeta: (m) => events.push(m),
    });
    expect(results.length).toBe(16); // every page, once
    expect(events).toHaveLength(0);
  });

  test('offset paging past the end returns empty without an exhaustion event', async () => {
    const events: unknown[] = [];
    const results = await engine.searchVector(basisEmbedding(0), {
      limit: 10,
      offset: 500,
      detail: 'high',
      onVectorPoolMeta: (m) => events.push(m),
    });
    expect(results.length).toBe(0);
    expect(events).toHaveLength(0);
  });
});
