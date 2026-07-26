import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import {
  alignEmbeddingDimension,
  invalidateMismatchedEmbeddingModels,
  recommendedEmbeddingDimension,
} from '../src/core/embedding-dimension-alignment.ts';
import {
  readContentChunksEmbeddingDim,
  readFactsEmbeddingDim,
} from '../src/core/embedding-dim-check.ts';
import { importFromContent } from '../src/core/import-file.ts';

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
    expect((await readFactsEmbeddingDim(engine)).dims).toBe(1024);
    const cacheDimension = await engine.executeRaw<{ formatted: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'query_cache'
          AND a.attname = 'embedding'
          AND NOT a.attisdropped`,
    );
    expect(cacheDimension[0]?.formatted).toMatch(/(?:halfvec|vector)\(1024\)/);

    const retained = await engine.executeRaw<{ pages: number; chunks: number; embedded: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM pages WHERE slug = 'alignment/source') AS pages,
         (SELECT COUNT(*)::int FROM content_chunks WHERE chunk_text = 'preserved chunk') AS chunks,
         (SELECT COUNT(*)::int FROM content_chunks WHERE embedding IS NOT NULL) AS embedded`,
    );
    expect(retained[0]).toEqual({ pages: 1, chunks: 1, embedded: 0 });
  });

  test('invalidates derived embeddings when the model changes at the same dimension', async () => {
    const pages = await engine.executeRaw<{ id: number }>(
      "SELECT id FROM pages WHERE slug = 'alignment/source'",
    );
    const vector = `[${new Array(1024).fill('0').join(',')}]`;
    await engine.executeRaw(
      `UPDATE content_chunks
         SET embedding = '${vector}',
             embedded_at = NOW(),
             model = 'zhipu:embedding-3'
       WHERE page_id = ${pages[0].id}`,
    );

    const result = await alignEmbeddingDimension(engine, 1024, {
      forceReembed: true,
      targetModel: 'ollama:qwen3-embedding:0.6b',
    });

    expect(result.status).toBe('invalidated');
    expect(result.previous_dimensions).toBe(1024);
    expect(result.cleared_embeddings).toBe(1);
    const rows = await engine.executeRaw<{ embedding: unknown; embedded_at: unknown; model: string | null }>(
      `SELECT embedding, embedded_at, model
         FROM content_chunks
        WHERE page_id = ${pages[0].id}`,
    );
    expect(rows[0]).toEqual({
      embedding: null,
      embedded_at: null,
      model: 'ollama:qwen3-embedding:0.6b',
    });
  });

  test('repairs vectors left behind by a model switch completed on an older version', async () => {
    const pages = await engine.executeRaw<{ id: number }>(
      "SELECT id FROM pages WHERE slug = 'alignment/source'",
    );
    const vector = `[${new Array(1024).fill('0').join(',')}]`;
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = '${vector}',
              embedded_at = NOW(),
              model = 'zhipu:embedding-3'
        WHERE page_id = ${pages[0].id}`,
    );

    const invalidated = await invalidateMismatchedEmbeddingModels(
      engine,
      'ollama:qwen3-embedding:0.6b',
    );
    expect(invalidated).toBe(1);
    const rows = await engine.executeRaw<{ embedding: unknown; model: string }>(
      `SELECT embedding, model FROM content_chunks WHERE page_id = ${pages[0].id}`,
    );
    expect(rows[0]).toEqual({
      embedding: null,
      model: 'ollama:qwen3-embedding:0.6b',
    });
    expect(await invalidateMismatchedEmbeddingModels(engine, 'ollama:qwen3-embedding:0.6b')).toBe(0);
  });

  test('normal alignment repairs old-model vectors without forcing a full rebuild', async () => {
    const pages = await engine.executeRaw<{ id: number }>(
      "SELECT id FROM pages WHERE slug = 'alignment/source'",
    );
    const vector = `[${new Array(1024).fill('0').join(',')}]`;
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = '${vector}',
              embedded_at = NOW(),
              model = 'zhipu:embedding-3'
        WHERE page_id = ${pages[0].id}`,
    );

    const result = await alignEmbeddingDimension(engine, 1024, {
      targetModel: 'ollama:qwen3-embedding:0.6b',
    });

    expect(result.status).toBe('invalidated');
    expect(result.cleared_embeddings).toBe(1);
    const retained = await engine.executeRaw<{
      pages: number;
      chunks: number;
      embedded: number;
      target_model: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM pages WHERE slug = 'alignment/source') AS pages,
         (SELECT COUNT(*)::int FROM content_chunks WHERE chunk_text = 'preserved chunk') AS chunks,
         (SELECT COUNT(*)::int FROM content_chunks WHERE embedding IS NOT NULL) AS embedded,
         (SELECT COUNT(*)::int FROM content_chunks WHERE model = 'ollama:qwen3-embedding:0.6b') AS target_model`,
    );
    expect(retained[0]).toEqual({ pages: 1, chunks: 1, embedded: 0, target_model: 1 });
  });

  test('imports and capture writes work after a 1280-to-1024 compatibility repair', async () => {
    configureGateway({
      embedding_model: 'zhipu:embedding-3',
      embedding_dimensions: 1024,
      env: { ZHIPUAI_API_KEY: 'test-key' },
    });
    __setEmbedTransportForTests(async options => ({
      embeddings: options.values.map(() => new Array(1024).fill(0.1)),
      usage: { tokens: options.values.length },
      warnings: [],
    }) as any);

    const imported = await importFromContent(
      engine,
      'compatibility/imported-file',
      '# Imported after repair\n\nThe existing knowledge database remains writable.',
    );
    const captured = await importFromContent(
      engine,
      'inbox/captured-after-repair',
      '# Captured after repair\n\nChanging the title or slug is not required.',
      { source_kind: 'capture-cli', ingested_via: 'capture-cli' },
    );

    expect(imported.status).toBe('imported');
    expect(imported.chunks).toBeGreaterThan(0);
    expect(captured.status).toBe('imported');
    expect(captured.chunks).toBeGreaterThan(0);
    const rows = await engine.executeRaw<{ pages: number; embedded: number }>(
      `SELECT
         (SELECT COUNT(*)::int
            FROM pages
           WHERE slug IN ('compatibility/imported-file', 'inbox/captured-after-repair')) AS pages,
         (SELECT COUNT(*)::int
            FROM content_chunks c
            JOIN pages p ON p.id = c.page_id
           WHERE p.slug IN ('compatibility/imported-file', 'inbox/captured-after-repair')
             AND c.embedding IS NOT NULL) AS embedded`,
    );
    expect(rows[0]).toEqual({ pages: 2, embedded: imported.chunks + captured.chunks });
  });
});
