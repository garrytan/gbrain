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

// ============================================================
// Plan D9 (TODOS "positive underfill-event coverage for searchVector
// escalation"): the POSITIVE halves. Each describe below owns an isolated
// engine — the fixtures need >1000 chunks / >1000 pages and their own
// embedding dims, so they can't share the file-level corpus. Both describes
// reconfigure the global gateway BEFORE their own initSchema; the original
// engine above only searches after its beforeAll, so the reconfig can't
// touch its schema.
// ============================================================

describe('searchVector escalation — fire-at-cap positive (HNSW lane)', () => {
  // hnswIndexExpected('vector', <=2000 dims) → innerCap = HNSW_EF_SEARCH_MAX
  // (1000). Two dense pages carry 1120 embedded chunks between them, so the
  // pre-DISTINCT chunk pull stays FULL at every escalation rung
  // (100 → 400 → 1000) while the PAGE set stays at 2. The loop must stop at
  // the substrate ceiling AND report the exhaustion — the positive twin of
  // the two negative paths pinned above.
  let capEngine: PGLiteEngine;
  const CAP_DIM = 8; // small dims: 1120-chunk fixture stays fast; cap policy keys on type, not size

  function capEmb(cos: number): Float32Array {
    const e = new Float32Array(CAP_DIM);
    e[0] = cos;
    e[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
    return e;
  }

  beforeAll(async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: CAP_DIM,
      env: { ...process.env },
    });
    capEngine = new PGLiteEngine();
    await capEngine.connect({}); // in-memory
    await capEngine.initSchema();
    for (const slug of ['notes/dense-a', 'notes/dense-b']) {
      await capEngine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'dense.' });
      const chunks: ChunkInput[] = Array.from({ length: 560 }, (_, i) => ({
        chunk_index: i,
        chunk_text: `dense chunk ${i}`,
        chunk_source: 'compiled_truth' as const,
        embedding: capEmb(0.9 - i * 0.0001),
        token_count: 3,
      }));
      await capEngine.upsertChunks(slug, chunks);
    }
  }, 120_000);

  afterAll(async () => {
    await capEngine.disconnect();
    // Restore the file-level gateway shape: configureGateway fully replaces
    // the process-global config, and bun runs test files in one process — a
    // leaked 8-dim config could skew a later non-configuring file's initSchema.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIM,
      env: { ...process.env },
    });
  });

  test('initSchema on a <=2000-dim column builds the HNSW index (the capped substrate is real)', async () => {
    const idx = await capEngine.executeRaw(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_chunks_embedding'`,
    );
    expect(idx.length).toBe(1);
  });

  test('exhaustion at the ef_search cap EMITS the underfill event', async () => {
    const events: Array<{ underfilled: boolean; escalations: number; innerLimit: number }> = [];
    const results = await capEngine.searchVector(capEmb(1), {
      limit: 10,
      detail: 'high',
      onVectorPoolMeta: (m) => events.push(m),
    });
    // Page set is genuinely short (2 dense pages < limit 10) but the chunk
    // pool was full at the cap — visible, not silent.
    expect(results.length).toBe(2);
    expect(new Set(results.map((r) => r.slug))).toEqual(new Set(['notes/dense-a', 'notes/dense-b']));
    expect(events).toEqual([{ underfilled: true, escalations: 2, innerLimit: 1000 }]);
  });
});

describe('searchVector escalation — exact-scan lane (>2000-dim column, cap keyed on hnswIndexExpected)', () => {
  // hnswIndexExpected('vector', 2100) === false → pgvector can't build an
  // HNSW index, searches are exact scans, and capping the SQL LIMIT at the
  // ef_search ceiling would make offset >= 1000 PERMANENTLY empty. R2-10:
  // above-ceiling columns skip the cap (bounded by escalation count
  // instead). Previously pinned only by inspection.
  let exactEngine: PGLiteEngine;
  const EXACT_DIM = 2100;
  const DEEP_PAGES = 1050;
  // What the registry-backed resolver hands searchVector on a >2000-dim brain.
  const descriptor = { name: 'embedding', type: 'vector' as const, dimensions: EXACT_DIM, embeddingModel: '' };

  function exactEmb(): Float32Array {
    const e = new Float32Array(EXACT_DIM);
    e[0] = 1;
    return e;
  }

  beforeAll(async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: EXACT_DIM,
      env: { ...process.env },
    });
    exactEngine = new PGLiteEngine();
    await exactEngine.connect({}); // in-memory
    await exactEngine.initSchema();
    // 1050 pages × 1 chunk, all with IDENTICAL embeddings: every raw_score
    // ties, so the pinned deterministic order is the score-tie tiebreaker
    // (page_id ASC) and deep-offset rows are exactly the seed order.
    for (let p = 0; p < DEEP_PAGES; p++) {
      const slug = `deep/page-${String(p).padStart(4, '0')}`;
      await exactEngine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'deep.' });
      await exactEngine.upsertChunks(slug, [
        {
          chunk_index: 0,
          chunk_text: `deep ${p}`,
          chunk_source: 'compiled_truth',
          embedding: exactEmb(),
          token_count: 2,
        },
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    await exactEngine.disconnect();
    // Restore the file-level gateway shape (see the fire-at-cap afterAll).
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIM,
      env: { ...process.env },
    });
  });

  test('initSchema on a >2000-dim column builds NO hnsw index (exact-scan substrate)', async () => {
    const idx = await exactEngine.executeRaw(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_chunks_embedding'`,
    );
    expect(idx.length).toBe(0);
  });

  test('deep offsets past the ef_search ceiling keep working with the real >2000-dim descriptor', async () => {
    const events: unknown[] = [];
    const results = await exactEngine.searchVector(exactEmb(), {
      limit: 10,
      offset: 1040,
      detail: 'high',
      embeddingColumn: descriptor,
      onVectorPoolMeta: (m) => events.push(m),
    });
    // innerLimit = offset + max(limit*5, 100) = 1140, UNCAPPED: the single
    // pass reaches pages 1041–1050. With the (wrong) HNSW-shaped cap this
    // offset is permanently empty — see the contrast case below.
    expect(results.length).toBe(10);
    expect(results.map((r) => r.slug)).toEqual(
      Array.from({ length: 10 }, (_, i) => `deep/page-${String(1040 + i).padStart(4, '0')}`),
    );
    expect(events).toHaveLength(0);
  });

  test('contrast: an HNSW-shaped descriptor caps the same deep offset at the substrate ceiling', async () => {
    // The cap keys on the DESCRIPTOR (hnswIndexExpected), not the physical
    // index: the default legacy descriptor claims vector/1536 → cap 1000 →
    // the inner pool can never reach row 1041. Production callers on a
    // >2000-dim brain always get the real descriptor from the registry
    // resolver; this pins the seam the R2-10 policy hangs off.
    const events: unknown[] = [];
    const results = await exactEngine.searchVector(exactEmb(), {
      limit: 10,
      offset: 1040,
      detail: 'high',
      onVectorPoolMeta: (m) => events.push(m),
    });
    expect(results.length).toBe(0);
    // Zero rows at offset>0 → pool unknowable → no event (the negative
    // deep-pagination contract pinned above holds here too).
    expect(events).toHaveLength(0);
  });
});
