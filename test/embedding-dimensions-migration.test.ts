import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import { resetEmbeddingConfigCache } from '../src/core/embedding-config.ts';

const ENV_KEY = 'GBRAIN_EMBED_DIMENSIONS';
const MODEL_KEY = 'GBRAIN_EMBED_MODEL';
const original = process.env[ENV_KEY];
const originalModel = process.env[MODEL_KEY];

interface MockState {
  calls: Array<{ sql: string; params?: unknown[] }>;
  embeddedRows: number;
}

function makeMockEngine(state: MockState): BrainEngine {
  return {
    executeRaw: async (sql: string, params?: unknown[]) => {
      state.calls.push({ sql, params });
      if (sql.includes('SELECT COUNT') && sql.includes('embedding IS NOT NULL')) {
        return [{ embedded: state.embeddedRows }];
      }
      return [];
    },
  } as unknown as BrainEngine;
}

beforeEach(() => {
  delete process.env[ENV_KEY];
  delete process.env[MODEL_KEY];
  resetEmbeddingConfigCache();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  delete process.env[MODEL_KEY];
  if (original !== undefined) process.env[ENV_KEY] = original;
  if (originalModel !== undefined) process.env[MODEL_KEY] = originalModel;
  resetEmbeddingConfigCache();
});

describe('v33 configurable_embedding_dimensions migration', () => {
  test('migration is registered at version 33', () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    expect(v33).toBeDefined();
    expect(v33?.name).toBe('configurable_embedding_dimensions');
  });

  test('LATEST_VERSION is 33', () => {
    expect(LATEST_VERSION).toBe(33);
  });

  test('default dim (1536) is a no-op', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    const state: MockState = { calls: [], embeddedRows: 0 };
    const engine = makeMockEngine(state);

    await v33?.handler?.(engine);

    expect(state.calls.length).toBe(0);
  });

  test('non-default dim with empty embeddings: drops index, alters, recreates', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    process.env[ENV_KEY] = '768';
    resetEmbeddingConfigCache();

    const state: MockState = { calls: [], embeddedRows: 0 };
    const engine = makeMockEngine(state);

    await v33?.handler?.(engine);

    // 1 SELECT COUNT, 1 DROP INDEX, 1 ALTER TYPE, 1 CREATE INDEX, 1 INSERT config
    expect(state.calls.length).toBe(5);
    expect(state.calls[0].sql).toMatch(/SELECT COUNT/);
    expect(state.calls[1].sql).toMatch(/DROP INDEX IF EXISTS idx_chunks_embedding/);
    expect(state.calls[2].sql).toMatch(/ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector\(768\)/);
    expect(state.calls[3].sql).toMatch(/CREATE INDEX idx_chunks_embedding/);
    expect(state.calls[3].sql).toMatch(/hnsw/);
    expect(state.calls[4].sql).toMatch(/INSERT INTO config/);
    expect(state.calls[4].params).toEqual(['768']);
  });

  test('non-default dim with custom model: also updates embedding_model config row', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    process.env[ENV_KEY] = '768';
    process.env[MODEL_KEY] = 'nomic-embed-text';
    resetEmbeddingConfigCache();

    const state: MockState = { calls: [], embeddedRows: 0 };
    const engine = makeMockEngine(state);

    await v33?.handler?.(engine);

    // 1 SELECT, 1 DROP, 1 ALTER, 1 CREATE INDEX, 1 dims-config, 1 model-config = 6
    expect(state.calls.length).toBe(6);
    const lastCall = state.calls[5];
    expect(lastCall.sql).toMatch(/INSERT INTO config/);
    expect(lastCall.params).toEqual(['nomic-embed-text']);
  });

  test('non-default dim WITH existing embeddings: throws with actionable message', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    process.env[ENV_KEY] = '768';
    resetEmbeddingConfigCache();

    const state: MockState = { calls: [], embeddedRows: 4372 };
    const engine = makeMockEngine(state);

    await expect(v33?.handler?.(engine)).rejects.toThrow(/4372 chunk\(s\) already have embeddings/);
    await expect(v33?.handler?.(engine)).rejects.toThrow(/UPDATE content_chunks SET embedding = NULL/);
    await expect(v33?.handler?.(engine)).rejects.toThrow(/local-models\.md/);
  });

  test('invalid dim falls back to default (no-op, no error)', async () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    process.env[ENV_KEY] = '99999'; // exceeds pgvector ceiling
    resetEmbeddingConfigCache();

    const state: MockState = { calls: [], embeddedRows: 0 };
    const engine = makeMockEngine(state);

    // getEmbeddingConfig returns 1536 fallback, so handler is a no-op
    await v33?.handler?.(engine);
    expect(state.calls.length).toBe(0);
  });

  test('handler is async function', () => {
    const v33 = MIGRATIONS.find(m => m.version === 33);
    expect(v33?.handler?.constructor.name).toBe('AsyncFunction');
  });
});
