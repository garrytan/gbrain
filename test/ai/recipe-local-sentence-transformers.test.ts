import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';

describe('recipe: local-sentence-transformers', () => {
  test('registers the BAAI/bge-m3 local embedding service honestly', () => {
    const r = getRecipe('local-sentence-transformers');
    expect(r).toBeTruthy();
    expect(r!.id).toBe('local-sentence-transformers');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.touchpoints.embedding!.models).toContain('BAAI/bge-m3');
    expect(r!.touchpoints.embedding!.default_dims).toBe(1536);
    expect(r!.touchpoints.embedding!.cost_per_1m_tokens_usd).toBe(0);
    expect(r!.touchpoints.embedding!.no_batch_cap).toBe(true);
    expect(r!.auth_env!.required).toEqual([]);
  });

  test('threads LOCAL_SENTENCE_TRANSFORMERS_BASE_URL into gateway base URLs', () => {
    const prev = process.env.LOCAL_SENTENCE_TRANSFORMERS_BASE_URL;
    process.env.LOCAL_SENTENCE_TRANSFORMERS_BASE_URL = 'http://127.0.0.1:8765/v1';
    try {
      const cfg = buildGatewayConfig({
        engine: 'pglite',
        embedding_model: 'local-sentence-transformers:BAAI/bge-m3',
        embedding_dimensions: 1536,
      });
      expect(cfg.base_urls?.['local-sentence-transformers']).toBe('http://127.0.0.1:8765/v1');
    } finally {
      if (prev === undefined) delete process.env.LOCAL_SENTENCE_TRANSFORMERS_BASE_URL;
      else process.env.LOCAL_SENTENCE_TRANSFORMERS_BASE_URL = prev;
    }
  });
});
