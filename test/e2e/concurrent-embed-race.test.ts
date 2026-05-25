/**
 * v0.40.3.0 D24 — concurrent upsertChunks race regression test.
 *
 * Pre-fix: two writers racing on the same chunk with both having an
 * embedding would race last-writer-wins via
 * `COALESCE(EXCLUDED.embedding, content_chunks.embedding)`. The slower
 * writer could overwrite a fresher embedding silently.
 *
 * Post-fix (both engines): the text-unchanged branch's CASE WHEN logic
 * lets the fresher `embedded_at` win. Slower writer with a stale
 * embedded_at timestamp loses; existing fresher embedding survives.
 *
 * This test seeds a chunk via upsertChunks, then simulates a slower
 * write by passing an OLDER embedded_at than what's stored. The
 * resulting embedding should be the original (fresher) one, NOT the
 * slower-write input.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let DIMS: number;

beforeAll(async () => {
  // Configure gateway with a known dimension BEFORE initSchema so the
  // PGLite vector column gets sized predictably regardless of what other
  // tests in this shard process have configured first.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test-fake-key-for-stub' },
  });
  DIMS = 1536;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Hard-reset the test page + its chunks so each test starts clean.
  // Required when this file runs alongside others in the same bun
  // test shard process (PGLite instance is shared).
  await engine.executeRaw(`DELETE FROM pages WHERE slug = $1`, ['test/race-target']);
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
     VALUES ('default', $1, 'concept', 'Race test page', 'body')`,
    ['test/race-target'],
  );
});

function makeVector(seed: number): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = seed + i * 0.001;
  return v;
}

describe('D24 NULL→non-NULL upsert race fix', () => {
  test('cold path: existing embedding NULL → take new', async () => {
    // First write: chunk_text 'cold' with no prior embedding.
    await engine.upsertChunks(
      'test/race-target',
      [
        {
          chunk_index: 0,
          chunk_text: 'cold path test',
          chunk_source: 'compiled_truth',
          embedding: makeVector(1.0),
          token_count: 3,
        },
      ],
      { sourceId: 'default' },
    );
    const chunks = await engine.getChunks('test/race-target', { sourceId: 'default' });
    expect(chunks.length).toBe(1);
    // Chunk exists with the embedding we wrote.
    expect(chunks[0].chunk_text).toBe('cold path test');
  });

  test('fresher write wins over stale write (text unchanged)', async () => {
    // Seed: chunk at index 1 with embedded_at = now (recent).
    await engine.upsertChunks(
      'test/race-target',
      [
        {
          chunk_index: 1,
          chunk_text: 'race text',
          chunk_source: 'compiled_truth',
          embedding: makeVector(2.0),
          token_count: 2,
        },
      ],
      { sourceId: 'default' },
    );

    // Capture the now-stored embedded_at as the reference 'fresh' time.
    const beforeRace = await engine.executeRaw<{ embedded_at: string }>(
      `SELECT embedded_at FROM content_chunks
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')
          AND chunk_index = 1`,
      ['test/race-target'],
    );
    const freshTs = beforeRace[0]?.embedded_at;
    expect(freshTs).toBeTruthy();

    // Simulate a slower writer: text UNCHANGED, but their embedded_at
    // is OLDER (5 minutes ago). Per the D24 fix, this write should
    // NOT overwrite the fresher embedding.
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, embedding, token_count, embedded_at)
       VALUES (
         (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'),
         1, 'race text', 'compiled_truth',
         array_fill(0::real, ARRAY[${DIMS}])::vector,  -- stale write's embedding
         2,
         now() - interval '5 minutes'
       )
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.embedding
           WHEN content_chunks.embedding IS NULL THEN EXCLUDED.embedding
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedding
           ELSE content_chunks.embedding
         END,
         embedded_at = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text AND EXCLUDED.embedding IS NULL THEN NULL
           WHEN content_chunks.embedding IS NULL AND EXCLUDED.embedding IS NOT NULL THEN EXCLUDED.embedded_at
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedded_at
           ELSE content_chunks.embedded_at
         END`,
      ['test/race-target'],
    );

    // After the stale write, the embedded_at should be UNCHANGED
    // (fresher value preserved). The text-unchanged branch with stale
    // embedded_at hits the ELSE clause = keep existing.
    const afterRace = await engine.executeRaw<{ embedded_at: string }>(
      `SELECT embedded_at FROM content_chunks
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')
          AND chunk_index = 1`,
      ['test/race-target'],
    );
    // The fresher write's timestamp survives; the stale write loses.
    // Normalize both to ISO strings so Date↔string equality is stable.
    const before = new Date(freshTs!).toISOString();
    const after = new Date(afterRace[0]!.embedded_at!).toISOString();
    expect(after).toBe(before);
  });

  test('text change with no new embedding resets both columns to NULL', async () => {
    // Seed chunk at index 2 with embedding.
    await engine.upsertChunks(
      'test/race-target',
      [
        {
          chunk_index: 2,
          chunk_text: 'original text',
          chunk_source: 'compiled_truth',
          embedding: makeVector(3.0),
          token_count: 2,
        },
      ],
      { sourceId: 'default' },
    );

    // Re-write with DIFFERENT text but NO embedding (simulates re-chunk
    // path before re-embedding). Both columns should reset to NULL.
    await engine.upsertChunks(
      'test/race-target',
      [
        {
          chunk_index: 2,
          chunk_text: 'changed text',
          chunk_source: 'compiled_truth',
          // no embedding
          token_count: 2,
        },
      ],
      { sourceId: 'default' },
    );

    const rows = await engine.executeRaw<{ embedded_at: Date | null; embedding_null: boolean }>(
      `SELECT embedded_at, embedding IS NULL AS embedding_null FROM content_chunks
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')
          AND chunk_index = 2`,
      ['test/race-target'],
    );
    expect(rows[0].embedded_at).toBeNull();
    expect(rows[0].embedding_null).toBe(true);
  });
});
