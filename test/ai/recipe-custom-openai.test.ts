import { afterAll, describe, expect, test } from 'bun:test';
import {
  applyOpenAICompatConfig,
  applyResolveAuth,
  configureGateway,
  defaultResolveAuth,
  detectEmbeddingDimensions,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

afterAll(() => resetGateway());

describe('custom-openai recipe', () => {
  test('registers one stable OpenAI-compatible provider for user-supplied models', () => {
    const recipe = getRecipe('custom-openai');
    expect(recipe).toBeDefined();
    expect(recipe!.implementation).toBe('openai-compatible');
    expect(recipe!.base_url_default).toBeUndefined();
    expect(recipe!.touchpoints.embedding?.user_provided_models).toBe(true);
    expect(recipe!.touchpoints.embedding?.default_dims).toBe(0);
    expect(recipe!.touchpoints.expansion).toBeDefined();
    expect(recipe!.touchpoints.chat?.supports_tools).toBe(true);
  });

  test('allows local endpoints without a key and uses an optional key when supplied', () => {
    const recipe = getRecipe('custom-openai')!;
    expect(defaultResolveAuth(recipe, {}, 'embedding')).toEqual({
      headerName: 'Authorization',
      token: 'Bearer unauthenticated',
    });
    expect(defaultResolveAuth(recipe, { CUSTOM_OPENAI_API_KEY: 'local-key' }, 'chat')).toEqual({
      headerName: 'Authorization',
      token: 'Bearer local-key',
    });
  });

  test('resolves separate chat and embedding API keys with the shared key as fallback', () => {
    const recipe = getRecipe('custom-openai')!;
    const config = {
      env: { CUSTOM_OPENAI_API_KEY: 'shared-key' },
      touchpoint_api_keys: {
        'custom-openai': {
          chat: 'chat-key',
          embedding: 'embedding-key',
        },
      },
    };
    expect(applyResolveAuth(recipe, config, 'chat')).toEqual({ apiKey: 'chat-key' });
    expect(applyResolveAuth(recipe, config, 'embedding')).toEqual({ apiKey: 'embedding-key' });
    expect(applyResolveAuth(recipe, config, 'expansion')).toEqual({ apiKey: 'chat-key' });
    expect(applyResolveAuth(recipe, {
      env: { CUSTOM_OPENAI_API_KEY: 'shared-key' },
    }, 'embedding')).toEqual({ apiKey: 'shared-key' });
  });

  test('requires and resolves the configured Base URL', () => {
    const recipe = getRecipe('custom-openai')!;
    expect(applyOpenAICompatConfig(recipe, {
      env: {},
      base_urls: { 'custom-openai': 'http://127.0.0.1:8000/v1' },
    })).toEqual({ baseURL: 'http://127.0.0.1:8000/v1' });
    expect(() => applyOpenAICompatConfig(recipe, { env: {} })).toThrow('requires a base URL');
  });

  test('resolves separate chat and embedding Base URLs with legacy fallback', () => {
    const recipe = getRecipe('custom-openai')!;
    const config = {
      env: {},
      base_urls: { 'custom-openai': 'http://127.0.0.1:8000/v1' },
      touchpoint_base_urls: {
        'custom-openai': {
          chat: 'http://127.0.0.1:8001/v1',
          embedding: 'http://127.0.0.1:8002/v1',
        },
      },
    };
    expect(applyOpenAICompatConfig(recipe, config, 'chat')).toEqual({ baseURL: 'http://127.0.0.1:8001/v1' });
    expect(applyOpenAICompatConfig(recipe, config, 'embedding')).toEqual({ baseURL: 'http://127.0.0.1:8002/v1' });
    expect(applyOpenAICompatConfig(recipe, config, 'expansion')).toEqual({ baseURL: 'http://127.0.0.1:8001/v1' });
    expect(applyOpenAICompatConfig(recipe, config)).toEqual({ baseURL: 'http://127.0.0.1:8000/v1' });
  });

  test('probes embedding dimensions through a real OpenAI-compatible HTTP endpoint', async () => {
    let requestPath = '';
    let authorization = '';
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        authorization = request.headers.get('authorization') ?? '';
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: 'qwen-embedding',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });

    try {
      const origin = server.url.toString().replace(/\/$/, '');
      configureGateway({
        embedding_model: 'custom-openai:qwen-embedding',
        embedding_dimensions: 3,
        env: {},
        base_urls: { 'custom-openai': 'http://127.0.0.1:1/v1' },
        touchpoint_base_urls: { 'custom-openai': { embedding: `${origin}/v1` } },
        touchpoint_api_keys: { 'custom-openai': { embedding: 'embedding-key' } },
      });
      expect(await detectEmbeddingDimensions()).toBe(3);
      expect(requestPath).toBe('/v1/embeddings');
      expect(authorization).toBe('Bearer embedding-key');
    } finally {
      server.stop(true);
    }
  });
});
