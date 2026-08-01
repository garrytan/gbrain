/**
 * Azure OpenAI (v1 route) recipe smoke.
 *
 * Sibling of recipe-azure-openai.test.ts. Same two seams, different URL shape:
 * the deployment name travels in the request body as `model`, so the base URL
 * is deployment-free and one process can reach embeddings and chat at once.
 *
 * Coverage:
 *  - Recipe registered with expected shape (no AZURE_OPENAI_DEPLOYMENT required)
 *  - All three touchpoints declared (embedding, expansion, chat)
 *  - resolveAuth returns api-key, not Authorization Bearer
 *  - resolveAuth Entra mode returns a bearer from the token cache
 *  - resolveOpenAICompatConfig builds {endpoint}/openai/v1 and strips slashes
 *  - resolveOpenAICompatConfig throws when the endpoint is missing
 *  - api-version is spliced in ONLY when AZURE_OPENAI_API_VERSION is set
 *  - applyResolveAuth puts the key in headers (no double-auth)
 *  - all three touchpoints resolve to the same auth
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import {
  applyResolveAuth,
  applyOpenAICompatConfig,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

const FULL_ENV = {
  AZURE_OPENAI_API_KEY: 'az-fake-key',
  AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com',
};

const EMBED_URL = 'https://my-resource.openai.azure.com/openai/v1/embeddings';

/** Swap in a fetch that records the URL it was handed, then restore. */
async function captureUrls(fn: (record: string[]) => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: any) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    captured.push(url);
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
  try {
    await fn(captured);
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

describe('recipe: azure-openai-v1', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('azure-openai-v1');
    expect(r).toBeDefined();
    expect(r!.id).toBe('azure-openai-v1');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBeUndefined(); // env-templated only
    // The deployment goes in the request body on this route, so it is NOT
    // required env — that's the whole reason this recipe exists.
    expect(r!.auth_env?.required).toEqual(['AZURE_OPENAI_ENDPOINT']);
    expect(r!.auth_env?.required).not.toContain('AZURE_OPENAI_DEPLOYMENT');
    expect(r!.auth_env?.optional).toContain('AZURE_OPENAI_API_KEY');
    expect(r!.auth_env?.optional).toContain('AZURE_OPENAI_USE_ENTRA');
    expect(r!.auth_env?.optional).toContain('AZURE_OPENAI_API_VERSION');
  });

  test('declares embedding, expansion and chat touchpoints', () => {
    const r = getRecipe('azure-openai-v1')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.expansion).toBeDefined();
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.embedding!.models).toContain('text-embedding-3-large');
    expect(r.touchpoints.embedding!.default_dims).toBe(3072);
    expect(r.touchpoints.embedding!.dims_options).toContain(1536);
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    // Azure has no Anthropic-style cache_control breakpoints on this route.
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(false);
  });

  test('resolveAuth returns api-key header (NOT Authorization Bearer)', () => {
    const r = getRecipe('azure-openai-v1')!;
    const auth = r.resolveAuth!(FULL_ENV);
    expect(auth.headerName).toBe('api-key');
    expect(auth.token).toBe('az-fake-key');
    expect(auth.token).not.toContain('Bearer');
  });

  test('resolveAuth Entra mode returns Authorization Bearer from the token cache', async () => {
    const { __setEntraTokenForTests } = await import(
      '../../src/core/ai/recipes/azure-openai-v1.ts'
    );
    __setEntraTokenForTests('fake-aad-token');
    try {
      const r = getRecipe('azure-openai-v1')!;
      const auth = r.resolveAuth!({
        AZURE_OPENAI_ENDPOINT: FULL_ENV.AZURE_OPENAI_ENDPOINT,
        AZURE_OPENAI_USE_ENTRA: '1',
      });
      expect(auth.headerName).toBe('Authorization');
      expect(auth.token).toBe('Bearer fake-aad-token');
    } finally {
      __setEntraTokenForTests(null);
    }
  });

  test('AZURE_OPENAI_USE_ENTRA=1 forces Entra even with a key present', async () => {
    const { __setEntraTokenForTests } = await import(
      '../../src/core/ai/recipes/azure-openai-v1.ts'
    );
    __setEntraTokenForTests('fake-aad-token');
    try {
      const r = getRecipe('azure-openai-v1')!;
      const auth = r.resolveAuth!({ ...FULL_ENV, AZURE_OPENAI_USE_ENTRA: '1' });
      expect(auth.headerName).toBe('Authorization');
    } finally {
      __setEntraTokenForTests(null);
    }
  });

  test('resolveOpenAICompatConfig builds {endpoint}/openai/v1 with no deployment in the path', () => {
    const r = getRecipe('azure-openai-v1')!;
    const cfg = r.resolveOpenAICompatConfig!(FULL_ENV);
    expect(cfg.baseURL).toBe('https://my-resource.openai.azure.com/openai/v1');
    expect(cfg.baseURL).not.toContain('/deployments/');
    expect(typeof cfg.fetch).toBe('function');
  });

  test('resolveOpenAICompatConfig strips trailing slashes from the endpoint', () => {
    const r = getRecipe('azure-openai-v1')!;
    const cfg = r.resolveOpenAICompatConfig!({
      ...FULL_ENV,
      AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com//',
    });
    expect(cfg.baseURL).toBe('https://my-resource.openai.azure.com/openai/v1');
  });

  test('resolveOpenAICompatConfig throws when the endpoint is missing', () => {
    const r = getRecipe('azure-openai-v1')!;
    expect(() => r.resolveOpenAICompatConfig!({ AZURE_OPENAI_API_KEY: 'k' })).toThrow(
      AIConfigError,
    );
  });

  test('fetch wrapper leaves the URL alone when no api-version is set', async () => {
    const r = getRecipe('azure-openai-v1')!;
    const cfg = r.resolveOpenAICompatConfig!(FULL_ENV);
    const captured = await captureUrls(async () => {
      await cfg.fetch!(EMBED_URL);
    });
    expect(captured).toEqual([EMBED_URL]);
  });

  test('fetch wrapper splices api-version when AZURE_OPENAI_API_VERSION is set', async () => {
    const r = getRecipe('azure-openai-v1')!;
    const cfg = r.resolveOpenAICompatConfig!({
      ...FULL_ENV,
      AZURE_OPENAI_API_VERSION: 'preview',
    });
    const captured = await captureUrls(async () => {
      await cfg.fetch!(EMBED_URL);
    });
    expect(captured[0]).toBe(`${EMBED_URL}?api-version=preview`);
  });

  test('fetch wrapper does NOT double-add api-version when the caller already set it', async () => {
    const r = getRecipe('azure-openai-v1')!;
    const cfg = r.resolveOpenAICompatConfig!({
      ...FULL_ENV,
      AZURE_OPENAI_API_VERSION: 'preview',
    });
    const captured = await captureUrls(async () => {
      await cfg.fetch!(`${EMBED_URL}?api-version=2025-01-01`);
    });
    expect(captured[0]).toBe(`${EMBED_URL}?api-version=2025-01-01`);
  });

  test('key-mode fetch wrapper does NOT touch the Authorization header', async () => {
    const r = getRecipe('azure-openai-v1')!;
    const cfg = r.resolveOpenAICompatConfig!(FULL_ENV);
    const captured: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: any, init?: any) => {
      captured.push(init);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    try {
      await cfg.fetch!(EMBED_URL, { headers: { 'api-key': 'az-fake-key' } });
      expect(new Headers(captured[0]?.headers).get('Authorization')).toBeNull();
      expect(new Headers(captured[0]?.headers).get('api-key')).toBe('az-fake-key');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('Entra fetch wrapper refreshes the Authorization header per request', async () => {
    const { __setEntraTokenForTests } = await import(
      '../../src/core/ai/recipes/azure-openai-v1.ts'
    );
    __setEntraTokenForTests('fresh-aad-token');
    const r = getRecipe('azure-openai-v1')!;
    const cfg = r.resolveOpenAICompatConfig!({
      AZURE_OPENAI_ENDPOINT: FULL_ENV.AZURE_OPENAI_ENDPOINT,
      AZURE_OPENAI_USE_ENTRA: '1',
    });
    const capturedAuth: (string | null)[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: any, init?: any) => {
      capturedAuth.push(new Headers(init?.headers).get('Authorization'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    try {
      await cfg.fetch!(EMBED_URL, {
        headers: {
          Authorization: 'Bearer stale-instantiation-token',
          'content-type': 'application/json',
        },
      });
      expect(capturedAuth).toEqual(['Bearer fresh-aad-token']);
    } finally {
      globalThis.fetch = realFetch;
      __setEntraTokenForTests(null);
    }
  });

  test('applyResolveAuth puts the key in headers (NOT apiKey) — no double-auth', () => {
    const r = getRecipe('azure-openai-v1')!;
    const result = applyResolveAuth(r, { env: FULL_ENV } as any, 'embedding');
    expect(result.apiKey, 'apiKey must be undefined to avoid double-auth').toBeUndefined();
    expect(result.headers).toEqual({ 'api-key': 'az-fake-key' });
  });

  test('all three touchpoints get the same auth', () => {
    const r = getRecipe('azure-openai-v1')!;
    const embedding = applyResolveAuth(r, { env: FULL_ENV } as any, 'embedding');
    const expansion = applyResolveAuth(r, { env: FULL_ENV } as any, 'expansion');
    const chat = applyResolveAuth(r, { env: FULL_ENV } as any, 'chat');
    expect(embedding).toEqual(expansion);
    expect(expansion).toEqual(chat);
  });

  test('applyOpenAICompatConfig honors the recipe override', () => {
    const r = getRecipe('azure-openai-v1')!;
    const result = applyOpenAICompatConfig(r, { env: FULL_ENV } as any);
    expect(result.baseURL).toBe('https://my-resource.openai.azure.com/openai/v1');
    expect(typeof result.fetch).toBe('function');
  });

  test('dimsProviderOptions threads dimensions for text-embedding-3-* via openai-compat', async () => {
    const { dimsProviderOptions } = await import('../../src/core/ai/dims.ts');
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 3072)).toEqual({
      openaiCompatible: { dimensions: 3072 },
    });
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-3-small', 512)).toEqual({
      openaiCompatible: { dimensions: 512 },
    });
  });
});
