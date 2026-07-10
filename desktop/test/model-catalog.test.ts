import { describe, expect, test } from 'bun:test';
import { listDesktopProviderModels } from '../src/main/model-catalog.js';
import { getRecipe } from '../../src/core/ai/recipes/index.js';

describe('desktop provider model catalog', () => {
  test('returns provider-scoped known models', async () => {
    const result = await listDesktopProviderModels('zhipu', 'embedding');
    expect(result.models).toEqual(getRecipe('zhipu')!.touchpoints.embedding!.models);
    expect(result.source).toBe('catalog');
  });

  test('uses the CLI recipe registry as the single cloud model source', async () => {
    for (const provider of ['mimo', 'zhipu', 'deepseek', 'openai', 'anthropic', 'google', 'openrouter']) {
      const result = await listDesktopProviderModels(provider, 'chat');
      expect(result.models).toEqual(getRecipe(provider)!.touchpoints.chat!.models);
    }
  });

  test('loads installed Ollama models from the local tags endpoint', async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toEndWith('/api/tags');
      return new Response(JSON.stringify({ models: [{ name: 'bge-m3:latest' }, { model: 'nomic-embed-text:latest' }] }));
    }) as typeof fetch;
    const result = await listDesktopProviderModels('ollama', 'embedding', fakeFetch);
    expect(result.source).toBe('ollama');
    expect(result.models).toContain('bge-m3:latest');
    expect(result.models).toContain('nomic-embed-text:latest');
  });

  test('falls back to common Ollama embedding models when the service is offline', async () => {
    const fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    const result = await listDesktopProviderModels('ollama', 'embedding', fakeFetch);
    expect(result.models).toContain('nomic-embed-text');
    expect(result.warning).toContain('未连接到本机 Ollama');
  });
});
