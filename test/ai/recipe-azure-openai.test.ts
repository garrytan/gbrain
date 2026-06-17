/**
 * Azure OpenAI recipe smoke (Commit 8 of the v0.32 wave).
 *
 * Azure is the first recipe to exercise BOTH new seams:
 *   - resolveAuth → custom header (api-key, NOT Authorization Bearer)
 *   - resolveOpenAICompatConfig → templated baseURL + fetch wrapper that
 *     splices `?api-version=` onto every request
 *
 * Coverage:
 *  - Recipe registered with expected shape
 *  - resolveAuth returns api-key header; missing key → AIConfigError
 *  - resolveOpenAICompatConfig templates baseURL from endpoint + deployment
 *  - resolveOpenAICompatConfig throws when endpoint or deployment missing
 *  - fetch wrapper splices api-version query param (default + override)
 *  - applyResolveAuth puts the key in headers (NOT apiKey, no double-auth)
 *  - applyOpenAICompatConfig honors the recipe override
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
  AZURE_OPENAI_DEPLOYMENT: 'embed-deployment',
};

describe('recipe: azure-openai', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('azure-openai');
    expect(r).toBeDefined();
    expect(r!.id).toBe('azure-openai');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBeUndefined(); // env-templated only
    expect(r!.auth_env?.required).toEqual([
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_DEPLOYMENT',
    ]);
    expect(r!.auth_env?.optional).toContain('AZURE_OPENAI_API_VERSION');
  });

  test('embedding touchpoint declares 3 models + 1536 default + Matryoshka options', () => {
    const r = getRecipe('azure-openai')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models).toEqual([
      'text-embedding-3-large',
      'text-embedding-3-small',
      'text-embedding-ada-002',
    ]);
    expect(r.touchpoints.embedding!.default_dims).toBe(1536);
    expect(r.touchpoints.embedding!.dims_options).toContain(3072);
  });

  test('resolveAuth returns api-key header (NOT Authorization Bearer)', () => {
    const r = getRecipe('azure-openai')!;
    const auth = r.resolveAuth!({ AZURE_OPENAI_API_KEY: 'az-fake-key' });
    expect(auth.headerName).toBe('api-key');
    expect(auth.token).toBe('az-fake-key');
    expect(auth.token).not.toContain('Bearer'); // critical: no Bearer prefix
  });

  test('resolveAuth throws AIConfigError when AZURE_OPENAI_API_KEY missing', () => {
    const r = getRecipe('azure-openai')!;
    expect(() => r.resolveAuth!({})).toThrow(AIConfigError);
  });

  test('applyResolveAuth puts the key in headers (NOT apiKey) — no double-auth', () => {
    const r = getRecipe('azure-openai')!;
    const result = applyResolveAuth(r, { env: FULL_ENV } as any, 'embedding');
    expect(result.apiKey, 'apiKey must be undefined to avoid double-auth').toBeUndefined();
    expect(result.headers).toEqual({ 'api-key': 'az-fake-key' });
  });

  test('resolveOpenAICompatConfig templates baseURL from endpoint + deployment', () => {
    const r = getRecipe('azure-openai')!;
    const cfg = r.resolveOpenAICompatConfig!(FULL_ENV);
    expect(cfg.baseURL).toBe(
      'https://my-resource.openai.azure.com/openai/deployments/embed-deployment',
    );
    expect(typeof cfg.fetch).toBe('function');
  });

  test('resolveOpenAICompatConfig strips trailing slash from endpoint', () => {
    const r = getRecipe('azure-openai')!;
    const cfg = r.resolveOpenAICompatConfig!({
      ...FULL_ENV,
      AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com/',
    });
    expect(cfg.baseURL).toBe(
      'https://my-resource.openai.azure.com/openai/deployments/embed-deployment',
    );
  });

  test('resolveOpenAICompatConfig throws when endpoint or deployment missing', () => {
    const r = getRecipe('azure-openai')!;
    expect(() =>
      r.resolveOpenAICompatConfig!({
        AZURE_OPENAI_API_KEY: 'k',
        AZURE_OPENAI_DEPLOYMENT: 'd',
      }),
    ).toThrow(AIConfigError);
    expect(() =>
      r.resolveOpenAICompatConfig!({
        AZURE_OPENAI_API_KEY: 'k',
        AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com',
      }),
    ).toThrow(AIConfigError);
  });

  test('fetch wrapper splices ?api-version=... onto every request URL (default version)', async () => {
    const r = getRecipe('azure-openai')!;
    const cfg = r.resolveOpenAICompatConfig!(FULL_ENV);
    const wrapped = cfg.fetch!;
    // Stub global fetch to capture the URL the wrapper hands off.
    const captured: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, _init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      captured.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    try {
      await wrapped('https://my-resource.openai.azure.com/openai/deployments/embed-deployment/embeddings');
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain('api-version=');
      expect(captured[0]).toContain('2024-10-21'); // DEFAULT_API_VERSION
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('fetch wrapper honors AZURE_OPENAI_API_VERSION override', async () => {
    const r = getRecipe('azure-openai')!;
    const cfg = r.resolveOpenAICompatConfig!({
      ...FULL_ENV,
      AZURE_OPENAI_API_VERSION: '2025-04-01',
    });
    const captured: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      captured.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    try {
      await cfg.fetch!('https://my-resource.openai.azure.com/openai/deployments/embed-deployment/embeddings');
      expect(captured[0]).toContain('api-version=2025-04-01');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('fetch wrapper does NOT double-add api-version when caller already set it', async () => {
    const r = getRecipe('azure-openai')!;
    const cfg = r.resolveOpenAICompatConfig!(FULL_ENV);
    const captured: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      captured.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    try {
      await cfg.fetch!('https://my-resource.openai.azure.com/openai/deployments/embed-deployment/embeddings?api-version=2025-01-01');
      expect(captured[0]).toBe(
        'https://my-resource.openai.azure.com/openai/deployments/embed-deployment/embeddings?api-version=2025-01-01',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('applyOpenAICompatConfig honors the recipe override (templated URL)', () => {
    const r = getRecipe('azure-openai')!;
    const result = applyOpenAICompatConfig(r, { env: FULL_ENV } as any);
    expect(result.baseURL).toBe(
      'https://my-resource.openai.azure.com/openai/deployments/embed-deployment',
    );
    expect(typeof result.fetch).toBe('function');
  });

  test('dimsProviderOptions threads dimensions for text-embedding-3-* via openai-compat', async () => {
    // Codex finding #1: Azure (openai-compatible) was missing dim
    // passthrough for text-embedding-3-large. Without `dimensions`, Azure
    // returns 3072d; gbrain config expects 1536d → first embed hard-fails.
    const { dimsProviderOptions } = await import('../../src/core/ai/dims.ts');
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-3-small', 512))
      .toEqual({ openaiCompatible: { dimensions: 512 } });
    // ada-002 has no dimensions knob; recipe must accept the native 1536.
    expect(dimsProviderOptions('openai-compatible', 'text-embedding-ada-002', 1536))
      .toBeUndefined();
  });
});
