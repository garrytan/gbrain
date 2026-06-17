/**
 * Zhipu AI (BigModel) recipe smoke (Commit 7 of the v0.32 wave).
 *
 * Coverage:
 *  - Recipe registered with expected shape
 *  - default auth: ZHIPUAI_API_KEY → "Bearer <key>"; missing → AIConfigError
 *  - dims_options exposes [256, 512, 1024, 2048]; default 1024 (HNSW-compatible)
 *  - 2048-dim path falls into exact-scan branch via chunkEmbeddingIndexSql
 *    from src/core/vector-index.ts
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import {
  PGVECTOR_HNSW_VECTOR_MAX_DIMS,
  chunkEmbeddingIndexSql,
} from '../../src/core/vector-index.ts';

describe('recipe: zhipu', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('zhipu');
    expect(r).toBeDefined();
    expect(r!.id).toBe('zhipu');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(r!.auth_env?.required).toEqual(['ZHIPUAI_API_KEY']);
  });

  test('embedding touchpoint declares embedding-3 first + 1024 dims (HNSW-compatible default)', () => {
    const r = getRecipe('zhipu')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models[0]).toBe('embedding-3');
    expect(r.touchpoints.embedding!.models).toContain('embedding-2');
    expect(r.touchpoints.embedding!.default_dims).toBe(1024);
    expect(r.touchpoints.embedding!.dims_options).toEqual([256, 512, 1024, 2048]);
    // The default must stay HNSW-compatible.
    expect(r.touchpoints.embedding!.default_dims).toBeLessThanOrEqual(
      PGVECTOR_HNSW_VECTOR_MAX_DIMS,
    );
  });

  test('default auth: ZHIPUAI_API_KEY set → "Bearer <key>"', () => {
    const r = getRecipe('zhipu')!;
    const auth = defaultResolveAuth(r, { ZHIPUAI_API_KEY: 'fake-zhipu-key' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-zhipu-key');
  });

  test('default auth: missing ZHIPUAI_API_KEY → AIConfigError', () => {
    const r = getRecipe('zhipu')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });

  test('2048-dim option from dims_options falls into exact-scan branch', () => {
    // 2048d exceeds the HNSW cap, so chunkEmbeddingIndexSql returns the
    // exact-scan-skip-index path. Users picking 2048 trade ANN speed for
    // full embedding fidelity.
    const sql = chunkEmbeddingIndexSql(2048);
    expect(sql.toLowerCase()).toContain('skipped');
    expect(sql.toLowerCase()).toContain('hnsw');
  });

  test('1024-dim default returns the HNSW index SQL (fast path)', () => {
    const sql = chunkEmbeddingIndexSql(1024);
    expect(sql.toLowerCase()).toContain('create index');
    expect(sql.toLowerCase()).toContain('hnsw');
  });

  test('dimsProviderOptions threads dimensions for embedding-3 (Matryoshka)', async () => {
    // Codex finding #1: Zhipu embedding-3 is Matryoshka 256-2048. Without
    // `dimensions` on the wire, user-selected non-default dims are
    // silently ignored.
    const { dimsProviderOptions } = await import('../../src/core/ai/dims.ts');
    expect(dimsProviderOptions('openai-compatible', 'embedding-3', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
    expect(dimsProviderOptions('openai-compatible', 'embedding-3', 2048))
      .toEqual({ openaiCompatible: { dimensions: 2048 } });
    // embedding-2 is fixed-dim; no passthrough.
    expect(dimsProviderOptions('openai-compatible', 'embedding-2', 1024))
      .toBeUndefined();
  });
});
