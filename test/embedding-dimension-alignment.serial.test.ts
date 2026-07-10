import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import {
  alignEmbeddingDimension,
  recommendedEmbeddingDimension,
} from '../src/core/embedding-dimension-alignment.ts';
import { readContentChunksEmbeddingDim } from '../src/core/embedding-dim-check.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 1280,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('embedding dimension alignment', () => {
  test('uses the recommended Zhipu desktop dimension', () => {
    expect(recommendedEmbeddingDimension('zhipu:embedding-3')).toBe(1024);
    expect(recommendedEmbeddingDimension('zhipu:embedding-2')).toBe(1024);
  });

  test('rebuilds only derived text embeddings and preserves pages and chunks', async () => {
    await engine.putPage('alignment/source', {
      title: 'Alignment source',
      compiled_truth: 'Original knowledge remains available.',
      timeline: '',
      type: 'note',
    });
    const pages = await engine.executeRaw<{ id: number }>(
      "SELECT id FROM pages WHERE slug = 'alignment/source'",
    );
    const vector = `[${new Array(1280).fill('0').join(',')}]`;
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding) ` +
      `VALUES (${pages[0].id}, 0, 'preserved chunk', '${vector}')`,
    );

    const result = await alignEmbeddingDimension(engine, 1024);
    expect(result.status).toBe('aligned');
    expect(result.previous_dimensions).toBe(1280);
    expect(result.cleared_embeddings).toBe(1);
    expect((await readContentChunksEmbeddingDim(engine)).dims).toBe(1024);

    const retained = await engine.executeRaw<{ pages: number; chunks: number; embedded: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM pages WHERE slug = 'alignment/source') AS pages,
         (SELECT COUNT(*)::int FROM content_chunks WHERE chunk_text = 'preserved chunk') AS chunks,
         (SELECT COUNT(*)::int FROM content_chunks WHERE embedding IS NOT NULL) AS embedded`,
    );
    expect(retained[0]).toEqual({ pages: 1, chunks: 1, embedded: 0 });
  });
});
