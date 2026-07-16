/**
 * Amazon Bedrock (via LiteLLM proxy) recipe smoke.
 *
 * Bedrock has no direct OpenAI/Anthropic wire shape, so this recipe targets a
 * LiteLLM proxy front-end and carries NO required auth (AWS creds live on the
 * proxy). These tests pin: registration shape, the Matryoshka embedding dims,
 * the no-required-auth fallback, and — critically — that the optional
 * BEDROCK_PROXY_BASE_URL is NOT mistaken for a bearer token.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';

describe('recipe: bedrock', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('bedrock');
    expect(r).toBeDefined();
    expect(r!.id).toBe('bedrock');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('http://localhost:4000');
    // AWS creds live on the proxy — gbrain sends no key.
    expect(r!.auth_env?.required).toEqual([]);
    expect(r!.auth_env?.optional).toContain('BEDROCK_PROXY_BASE_URL');
    expect(r!.auth_env?.optional).toContain('BEDROCK_PROXY_API_KEY');
  });

  test('embedding touchpoint: Cohere Embed v4 first, 1536 default, Matryoshka dims', () => {
    const r = getRecipe('bedrock')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models[0]).toBe('us.cohere.embed-v4:0');
    expect(r.touchpoints.embedding!.default_dims).toBe(1536);
    expect(r.touchpoints.embedding!.dims_options).toEqual([256, 512, 1024, 1536]);
    // Every dims option ≤ 2000 (HNSW-compatible).
    for (const d of r.touchpoints.embedding!.dims_options ?? []) {
      expect(d).toBeLessThanOrEqual(2000);
    }
    expect(r.touchpoints.embedding!.max_batch_tokens).toBeGreaterThan(0);
    expect(r.touchpoints.embedding!.supports_multimodal).toBe(true);
  });

  test('chat touchpoint: Claude on Bedrock, tools; prompt cache off (openai-compat path)', () => {
    const r = getRecipe('bedrock')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models[0]).toBe('us.anthropic.claude-opus-4-8');
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    // Claude models, but chat routes through the OpenAI-compatible provider,
    // which drops the gateway's anthropic-only cacheControl markers. Caching is
    // a no-op here, so the recipe must advertise false (like other openai-compat
    // recipes) — the gateway invariant test enforces "only Anthropic = true".
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(false);
  });

  test('no-auth: missing all env → Bearer unauthenticated (proxy ignores it)', () => {
    const r = getRecipe('bedrock')!;
    const auth = defaultResolveAuth(r, {}, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer unauthenticated');
  });

  test('optional BEDROCK_PROXY_BASE_URL is NOT leaked as a bearer token', () => {
    // Regression guard: a URL-shaped optional env must be skipped by the
    // no-required-auth fallback (it belongs in base_urls, not Authorization).
    const r = getRecipe('bedrock')!;
    const auth = defaultResolveAuth(
      r,
      { BEDROCK_PROXY_BASE_URL: 'http://127.0.0.1:4000' },
      'embedding',
    );
    expect(auth.token).toBe('Bearer unauthenticated');
    expect(auth.token).not.toContain('http');
  });

  test('optional BEDROCK_PROXY_API_KEY, when set, becomes the bearer token', () => {
    const r = getRecipe('bedrock')!;
    const auth = defaultResolveAuth(
      r,
      { BEDROCK_PROXY_API_KEY: 'sk-proxy-master-key' },
      'chat',
    );
    expect(auth.token).toBe('Bearer sk-proxy-master-key');
  });

  test('resolveOpenAICompatConfig honors BEDROCK_PROXY_BASE_URL override', () => {
    const r = getRecipe('bedrock')!;
    expect(r.resolveOpenAICompatConfig).toBeDefined();
    const overridden = r.resolveOpenAICompatConfig!({
      BEDROCK_PROXY_BASE_URL: 'http://10.0.0.5:4100',
    });
    expect(overridden.baseURL).toBe('http://10.0.0.5:4100');
    // Falls back to the LiteLLM default when unset.
    const fallback = r.resolveOpenAICompatConfig!({});
    expect(fallback.baseURL).toBe('http://localhost:4000');
  });
});
