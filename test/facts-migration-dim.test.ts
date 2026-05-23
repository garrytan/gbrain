/**
 * v0.31 Phase 6 — migration v45 embedding dim resolution.
 *
 * Pins:
 *   - Migration uses HALFVEC on PGLite (recent pgvector bundled)
 *   - Dimension is resolved from config.embedding_dimensions, NOT
 *     hardcoded to 1536
 *   - HNSW index uses halfvec_cosine_ops (matching opclass)
 *   - Idempotent re-init does not re-create the column with a different shape
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('migration v45 facts column shape', () => {
  test('embedding column is HALFVEC (or VECTOR fallback) — not a different type', async () => {
    const rows = await engine.executeRaw<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name = 'embedding'`,
    );
    expect(rows.length).toBe(1);
    // HALFVEC on pgvector >= 0.7 (PGLite bundles this); falls back to VECTOR
    // on older Postgres. Either is acceptable.
    expect(['halfvec', 'vector']).toContain(rows[0].udt_name);
  });

  test('embedding dim matches the gateway-configured dim (not hardcoded 1536)', async () => {
    // The migration reads config.embedding_dimensions. PGLite's schema-init
    // seeds that to __EMBEDDING_DIMS__ replaced with the gateway dim (1536
    // by default). The dim used for the column must match.
    const dimRows = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
    );
    const expectedDim = dimRows.length > 0 ? parseInt(dimRows[0].value, 10) : 1536;

    // For the actual column type-modifier, query pg_attribute via atttypmod
    // (decoded by format_type).
    const formatRows = await engine.executeRaw<{ format_type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS format_type
       FROM pg_attribute
       WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`,
    );
    expect(formatRows.length).toBe(1);
    const formatStr = formatRows[0].format_type;
    // Shape: "halfvec(1536)" or "vector(1536)" — extract the parenthesized dim.
    const m = formatStr.match(/\((\d+)\)/);
    expect(m).not.toBeNull();
    expect(parseInt(m![1], 10)).toBe(expectedDim);
  });

  test('HNSW index uses opclass matching the column type', async () => {
    const rows = await engine.executeRaw<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'facts' AND indexname = 'idx_facts_embedding_hnsw'`,
    );
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef;
    // Either halfvec_cosine_ops (HALFVEC column) or vector_cosine_ops (fallback).
    expect(def).toMatch(/(halfvec_cosine_ops|vector_cosine_ops)/);
    // And the opclass must agree with the column type.
    const colRows = await engine.executeRaw<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name = 'embedding'`,
    );
    if (colRows[0].udt_name === 'halfvec') {
      expect(def).toContain('halfvec_cosine_ops');
    } else {
      expect(def).toContain('vector_cosine_ops');
    }
  });

  test('idempotent: re-running initSchema does not change the column type', async () => {
    const before = await engine.executeRaw<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name = 'embedding'`,
    );
    await engine.initSchema();
    const after = await engine.executeRaw<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name = 'embedding'`,
    );
    expect(after[0].udt_name).toBe(before[0].udt_name);
  });
});

describe('4096d local embeddings above HNSW caps', () => {
  test('facts/query_cache skip native HNSW above caps; content_chunks gets binary HNSW', async () => {
    resetGateway();
    configureGateway({
      embedding_model: 'llama-server:qwen3-embedding-8b',
      embedding_dimensions: 4096,
      env: {},
    });

    const local = new PGLiteEngine();
    try {
      await local.connect({});
      await local.initSchema();

      const dimRows = await local.executeRaw<{ value: string }>(
        `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
      );
      expect(dimRows[0].value).toBe('4096');

      const factsIndexRows = await local.executeRaw<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'facts' AND indexname = 'idx_facts_embedding_hnsw'`,
      );
      expect(factsIndexRows.length).toBe(0);

      const queryCacheIndexRows = await local.executeRaw<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'query_cache' AND indexname = 'idx_query_cache_embedding_hnsw'`,
      );
      expect(queryCacheIndexRows.length).toBe(0);

      const binaryIndexRows = await local.executeRaw<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'content_chunks' AND indexname = 'idx_chunks_embedding_binary_hnsw'`,
      );
      expect(binaryIndexRows.length).toBe(1);
      expect(binaryIndexRows[0].indexdef).toContain('binary_quantize');
      expect(binaryIndexRows[0].indexdef).toContain('bit(4096)');
    } finally {
      await local.disconnect();
      resetGateway();
    }
  });
});
