/**
 * T1 regression — searchVector per-page max-pool (retrieval-maxpool incident).
 *
 * The bug: `searchVector` returned chunk-grain top-k with NO `DISTINCT ON (slug)`.
 * A hub page with several strong chunks could occupy every early candidate slot,
 * crowding a different page's single strong chunk out of the result entirely, OR
 * returning the same page multiple times. The keyword path always pooled per page
 * via `best_per_page`; the vector path did not. This pins the fix.
 *
 * Failing-on-old-code construction:
 *   - query embeds at basis direction 0.
 *   - `notes/hub` has THREE chunks at cosine 0.99 / 0.98 / 0.97.
 *   - `notes/needle` has ONE chunk at cosine 0.95.
 *   - two fillers at 0.90.
 *   With limit=3 the OLD chunk-grain path returns [hub@0.99, hub@0.98, hub@0.97]
 *   — needle (rank 4 at chunk grain) is truncated and the page is absent, and hub
 *   appears 3×. The pooled path returns 3 DISTINCT pages [hub, needle, filler],
 *   so needle surfaces and hub appears once.
 *
 * `detail: 'high'` neutralizes the source-factor boost (buildSourceFactorCase
 * returns 1.0) so the assertion keys off pure cosine, not slug-prefix weighting.
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
  e[otherDim] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return e;
}

function basisEmbedding(idx: number): Float32Array {
  const e = new Float32Array(DIM);
  e[idx % DIM] = 1.0;
  return e;
}

beforeAll(async () => {
  // Pin the legacy OpenAI/1536 gateway BEFORE initSchema so the
  // content_chunks.embedding column is vector(1536), matching this file's
  // hardcoded 1536-d basis vectors. initSchema runs in beforeAll (before
  // any preload beforeEach can re-pin), so we cannot rely on the legacy
  // preload default surviving a sibling shard file that reconfigured the
  // gateway to the v0.37 ZE/1280 default and didn't reset.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { ...process.env },
  });
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();

  // Seeded first → lowest page_id. Three strong chunks.
  await engine.putPage('notes/hub', {
    type: 'note',
    title: 'Hub Page',
    compiled_truth: 'hub a. hub b. hub c.',
  });
  const hubChunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: 'hub a', chunk_source: 'compiled_truth', embedding: gradedEmb(0.99, 10), token_count: 2 },
    { chunk_index: 1, chunk_text: 'hub b', chunk_source: 'compiled_truth', embedding: gradedEmb(0.98, 11), token_count: 2 },
    { chunk_index: 2, chunk_text: 'hub c', chunk_source: 'compiled_truth', embedding: gradedEmb(0.97, 12), token_count: 2 },
  ];
  await engine.upsertChunks('notes/hub', hubChunks);

  // The page that MUST surface — one strong chunk, below hub's chunks but above fillers.
  await engine.putPage('notes/needle', {
    type: 'note',
    title: 'Needle Page',
    compiled_truth: 'the needle',
  });
  await engine.upsertChunks('notes/needle', [
    { chunk_index: 0, chunk_text: 'the needle', chunk_source: 'compiled_truth', embedding: gradedEmb(0.95, 13), token_count: 2 },
  ]);

  await engine.putPage('notes/filler-a', { type: 'note', title: 'Filler A', compiled_truth: 'filler a' });
  await engine.upsertChunks('notes/filler-a', [
    { chunk_index: 0, chunk_text: 'filler a', chunk_source: 'compiled_truth', embedding: gradedEmb(0.90, 14), token_count: 2 },
  ]);
  await engine.putPage('notes/filler-b', { type: 'note', title: 'Filler B', compiled_truth: 'filler b' });
  await engine.upsertChunks('notes/filler-b', [
    { chunk_index: 0, chunk_text: 'filler b', chunk_source: 'compiled_truth', embedding: gradedEmb(0.90, 15), token_count: 2 },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('searchVector per-page max-pool (T1)', () => {
  test('returns DISTINCT pages — no page appears more than once', async () => {
    const results = await engine.searchVector(basisEmbedding(0), { limit: 3, detail: 'high' });
    const slugs = results.map(r => r.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length); // pooling: one row per page
  });

  test('a strong chunk is NOT crowded out by a hub page (needle surfaces)', async () => {
    const results = await engine.searchVector(basisEmbedding(0), { limit: 3, detail: 'high' });
    const slugs = results.map(r => r.slug);
    // OLD chunk-grain path: top-3 = hub,hub,hub → needle absent. Pooled: needle present.
    expect(slugs).toContain('notes/needle');
    expect(slugs.filter(s => s === 'notes/hub').length).toBe(1);
  });

  test('hub still ranks #1 by its best chunk (max-pool keeps the strongest)', async () => {
    const results = await engine.searchVector(basisEmbedding(0), { limit: 3, detail: 'high' });
    expect(results[0].slug).toBe('notes/hub');
    // hub represented by its 0.99 chunk (chunk_index 0), not a weaker one
    expect(results[0].chunk_index).toBe(0);
  });

  test('larger limit returns each page once, ordered by best-chunk score', async () => {
    const results = await engine.searchVector(basisEmbedding(0), { limit: 10, detail: 'high' });
    const slugs = results.map(r => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs[0]).toBe('notes/hub');
    expect(slugs[1]).toBe('notes/needle'); // 0.95 beats the 0.90 fillers
  });
});
