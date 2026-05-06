import { afterEach, expect, mock, test } from 'bun:test';
import { configureGateway, embedOne, isAvailable, resetGateway } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGateway();
});

test('copilot recipe is registered for metis embeddings', () => {
  const recipe = getRecipe('copilot');
  expect(recipe?.touchpoints.embedding?.models).toContain('metis-1024-I16-Binary');
  expect(recipe?.touchpoints.embedding?.default_dims).toBe(1024);
});

test('copilot embedding provider calls GitHub embeddings endpoint without OpenAI-compatible body shape', async () => {
  const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.github.com/embeddings');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    expect(headers['X-GitHub-Api-Version']).toBe('2025-05-01');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ inputs: ['gbrain smoke test'], model: 'metis-1024-I16-Binary' });
    return new Response(JSON.stringify({ embeddings: [{ embedding: vector }] }), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  configureGateway({
    embedding_model: 'copilot:metis-1024-I16-Binary',
    embedding_dimensions: 1024,
    env: { GBRAIN_COPILOT_TOKEN: 'test-token' },
  });

  expect(isAvailable('embedding')).toBe(true);
  const result = await embedOne('gbrain smoke test');
  expect(result.length).toBe(1024);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
