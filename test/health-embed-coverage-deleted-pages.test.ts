/**
 * Fully indexed live pages report full health coverage and no waiting
 * chunks even when deleted pages retain unembedded chunks. Reverting the
 * coverage liveness filters in chunk_totals breaks this contract. Existing soft-delete
 * tests cover raw storage counts, not coverage with embedded live chunks.
 * Uses real PGLite page/projection methods; no production-only test seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let vector: Float32Array;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const [column] = await engine.executeRaw<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
  );
  vector = new Float32Array(column!.dims).fill(0.1);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

async function seedPage(slug: string, embedded: boolean, frontmatter = {}) {
  await engine.putPage(slug, {
    type: 'note', title: slug, compiled_truth: `Content of ${slug}`, frontmatter,
  });
  await installFixtureChunks(engine, slug, [0, 1].map(chunk_index => ({
    chunk_index, chunk_text: `Chunk ${chunk_index} of ${slug}`, chunk_source: 'compiled_truth',
    ...(embedded ? { embedding: vector } : {}),
  })));
}

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedPage('notes/live-a', true);
  await seedPage('notes/live-b', true);
  await seedPage('notes/deleted', false);
  expect(await engine.softDeletePage('notes/deleted')).toEqual({ slug: 'notes/deleted' });
});

describe('health embedding coverage excludes deleted pages (PGLite)', () => {
  test('fully embedded live pages have full coverage despite retained deleted chunks', async () => {
    const [retained] = await engine.executeRaw<{ chunks: number; unembedded: number }>(
      `SELECT count(*)::int AS chunks,
              count(*) FILTER (WHERE cc.embedding IS NULL)::int AS unembedded
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'notes/deleted' AND p.deleted_at IS NOT NULL`,
    );
    expect(retained).toEqual({ chunks: 2, unembedded: 2 });
    const health = await engine.getHealth();
    expect(health.embed_coverage).toBe(1);
    expect(health.missing_embeddings).toBe(0);
  });

  test('waiting count and list exclude the same deleted chunks', async () => {
    expect(await engine.countStaleChunks()).toBe(0);
    expect(await engine.listStaleChunks()).toEqual([]);
  });

  test('live unembedded chunks still lower coverage and appear as waiting', async () => {
    await seedPage('notes/live-waiting', false);
    const health = await engine.getHealth();
    expect(health.embed_coverage).toBeLessThan(1);
    expect(health.embed_coverage).toBeCloseTo(4 / 6, 10);
    expect(health.missing_embeddings).toBe(2);
    expect(await engine.countStaleChunks()).toBe(2);
    expect(await engine.listStaleChunks()).toHaveLength(2);
  });

  test('live embed_skip chunks remain excluded from coverage and waiting', async () => {
    await seedPage('notes/skipped', false, { embed_skip: true });
    const health = await engine.getHealth();
    expect(health.embed_coverage).toBe(1);
    expect(health.missing_embeddings).toBe(0);
    expect(await engine.countStaleChunks()).toBe(0);
    expect(await engine.listStaleChunks()).toEqual([]);
  });
});
