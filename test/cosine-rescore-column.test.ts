/**
 * v0.36 (D9 / CDX-3) — getEmbeddingsByChunkIds column-parameter tests.
 *
 * Pins:
 *   - Default param value 'embedding' preserves pre-v0.36 behavior.
 *   - Custom column parameter (e.g. 'embedding_voyage') hydrates from
 *     that column.
 *   - Invalid column name (regex-failing) throws
 *     EmbeddingColumnNotRegisteredError BEFORE any SQL runs.
 *   - Identifier-quoting safely interpolates the column name.
 *
 * Uses PGLite in-memory engine. ALTER TABLE adds an ad-hoc
 * `embedding_voyage` column to mimic the user's production state
 * where columns get added outside the committed schema.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  EmbeddingColumnNotRegisteredError,
} from '../src/core/search/embedding-column.ts';
import type { PageInput, ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;
let chunkId: number;
let chunkId2: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Add an ad-hoc voyage column at the same shape Garry's brain has —
  // outside the committed schema, declared per-instance.
  await (engine as any).db.exec(
    `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_voyage vector(1024)`,
  );

  // Seed a page with two chunks.
  const page: PageInput = {
    type: 'concept',
    title: 'Cosine Rescore Test',
    compiled_truth: 'Two chunks for rescore.',
  };
  await engine.putPage('test/cosine-rescore', page);

  const chunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: 'first chunk text', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'second chunk text', chunk_source: 'compiled_truth' },
  ];
  await engine.upsertChunks('test/cosine-rescore', chunks);

  // Read back chunk ids.
  const rows = await engine.executeRaw<{ id: number; chunk_index: number }>(
    `SELECT cc.id, cc.chunk_index FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = 'test/cosine-rescore'
      ORDER BY cc.chunk_index`,
  );
  chunkId = rows[0].id;
  chunkId2 = rows[1].id;

  // Plant distinct vectors in 'embedding' (1536d) and 'embedding_voyage'
  // (1024d) so we can prove the column parameter actually selects.
  const v1536a = new Array(1536).fill(0).map(() => 0.001).join(',');
  const v1536b = new Array(1536).fill(0).map(() => 0.002).join(',');
  const v1024a = new Array(1024).fill(0).map(() => 0.5).join(',');
  const v1024b = new Array(1024).fill(0).map(() => 0.6).join(',');

  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding = $1::vector WHERE id = $2`,
    [`[${v1536a}]`, chunkId],
  );
  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding = $1::vector WHERE id = $2`,
    [`[${v1536b}]`, chunkId2],
  );
  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding_voyage = $1::vector WHERE id = $2`,
    [`[${v1024a}]`, chunkId],
  );
  await (engine as any).db.query(
    `UPDATE content_chunks SET embedding_voyage = $1::vector WHERE id = $2`,
    [`[${v1024b}]`, chunkId2],
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('getEmbeddingsByChunkIds — column parameter (D9)', () => {
  test('default param fetches from "embedding" — preserves pre-v0.36 behavior', async () => {
    const map = await engine.getEmbeddingsByChunkIds([chunkId, chunkId2]);
    expect(map.size).toBe(2);
    expect(map.get(chunkId)!.length).toBe(1536);
    expect(map.get(chunkId2)!.length).toBe(1536);
    // First-element matches what we seeded for the primary column.
    expect(map.get(chunkId)![0]).toBeCloseTo(0.001, 5);
  });

  test('column="embedding_voyage" fetches from the alt column', async () => {
    const map = await engine.getEmbeddingsByChunkIds([chunkId, chunkId2], 'embedding_voyage');
    expect(map.size).toBe(2);
    expect(map.get(chunkId)!.length).toBe(1024);
    expect(map.get(chunkId2)!.length).toBe(1024);
    // First-element matches what we seeded for voyage.
    expect(map.get(chunkId)![0]).toBeCloseTo(0.5, 5);
  });

  test('invalid column param throws BEFORE SQL runs (regex-rejected)', async () => {
    let threw: Error | null = null;
    try {
      await engine.getEmbeddingsByChunkIds([chunkId], 'embedding"; DROP --');
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).toBeTruthy();
    expect(threw).toBeInstanceOf(EmbeddingColumnNotRegisteredError);
  });

  test('empty id list short-circuits (no SQL run)', async () => {
    const map = await engine.getEmbeddingsByChunkIds([], 'embedding_voyage');
    expect(map.size).toBe(0);
  });
});
