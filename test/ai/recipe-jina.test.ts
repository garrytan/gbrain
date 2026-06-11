import { afterAll, beforeEach, describe, test, expect } from 'bun:test';
import { jina } from '../../src/core/ai/recipes/jina.ts';
import { RECIPES, getRecipe } from '../../src/core/ai/recipes/index.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { configureGateway, embed, embedQuery, resetGateway } from '../../src/core/ai/gateway.ts';

beforeEach(() => resetGateway());
afterAll(() => resetGateway());

describe('jina recipe shape', () => {
  test('registers a no-auth local/OpenAI-compatible embedding recipe', () => {
    expect(jina.id).toBe('jina');
    expect(jina.implementation).toBe('openai-compatible');
    expect(jina.base_url_default).toBe('http://localhost:8081/v1');
    expect(jina.auth_env!.required).toEqual([]);
    expect(jina.auth_env!.optional).toContain('JINA_API_KEY');
    expect(jina.auth_env!.optional).toContain('JINA_BASE_URL');
    expect(RECIPES.has('jina')).toBe(true);
    expect(getRecipe('jina')).toBe(jina);
  });

  test('declares Jina v5 retrieval embeddings with stable 1024d default', () => {
    const embedding = jina.touchpoints.embedding!;

    expect(embedding.models).toContain('jinaai/jina-embeddings-v5-omni-small');
    expect(embedding.models).toContain('jina-embeddings-v5-text-small');
    expect(embedding.default_dims).toBe(1024);
    expect(embedding.dims_options).toEqual([32, 64, 128, 256, 512, 768, 1024]);
    expect(embedding.max_batch_tokens).toBe(120_000);
    expect(embedding.chars_per_token).toBe(1);
    expect(embedding.safety_factor).toBe(0.5);
  });
});

describe('jina gateway embedding requests', () => {
  test('sends document and query input_type to the OpenAI-compatible endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          {
            object: 'embedding',
            index: 0,
            embedding: new Array(1024).fill(0.01),
          },
        ],
        model: 'jinaai/jina-embeddings-v5-omni-small',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      configureGateway({
        embedding_model: 'jina:jinaai/jina-embeddings-v5-omni-small',
        embedding_dimensions: 1024,
        base_urls: { jina: 'http://127.0.0.1:8091/v1' },
        env: {},
      });

      await embed(['page chunk']);
      await embedQuery('search query');

      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]).toMatchObject({
        model: 'jinaai/jina-embeddings-v5-omni-small',
        dimensions: 1024,
        input_type: 'document',
      });
      expect(requestBodies[1]).toMatchObject({
        model: 'jinaai/jina-embeddings-v5-omni-small',
        dimensions: 1024,
        input_type: 'query',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('jina embedding provider options', () => {
  test('threads query/document input_type plus dimensions for Jina v5 retrieval models', () => {
    expect(dimsProviderOptions(
      'openai-compatible',
      'jinaai/jina-embeddings-v5-omni-small',
      1024,
      'query',
    )).toEqual({ openaiCompatible: { dimensions: 1024, user: 'gbrain-input-type:query' } });

    expect(dimsProviderOptions(
      'openai-compatible',
      'jinaai/jina-embeddings-v5-omni-small',
      768,
      'document',
    )).toEqual({ openaiCompatible: { dimensions: 768, user: 'gbrain-input-type:document' } });
  });

  test('rejects dimensions outside Jina v5 Matryoshka options', () => {
    expect(() => dimsProviderOptions(
      'openai-compatible',
      'jinaai/jina-embeddings-v5-omni-small',
      1536,
      'query',
    )).toThrow(AIConfigError);
  });
});
