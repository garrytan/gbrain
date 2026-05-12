/**
 * llama-server recipe smoke (Commit 4 of the v0.32 wave).
 *
 * llama-server is the second user-driven-models recipe (alongside
 * litellm-proxy). It declares `models: []`, `user_provided_models: true`,
 * and a `probe()` that consults LLAMA_SERVER_BASE_URL.
 *
 * Coverage:
 *  - Recipe registered + has expected fields
 *  - user_provided_models is the explicit signal (not the legacy id heuristic)
 *  - probe is callable and reports `ready: false` with a setup hint when no server is listening
 *  - default auth resolves to "Bearer unauthenticated" (or the API key if set)
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { withEnv } from '../helpers/with-env.ts';

describe('recipe: llama-server', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('llama-server');
    expect(r).toBeDefined();
    expect(r!.id).toBe('llama-server');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('http://localhost:8080/v1');
    expect(r!.auth_env?.required ?? []).toEqual([]);
    expect(r!.auth_env?.optional ?? []).toContain('LLAMA_SERVER_BASE_URL');
    expect(r!.auth_env?.optional ?? []).toContain('LLAMA_SERVER_API_KEY');
  });

  test('embedding touchpoint declares user_provided_models', () => {
    const r = getRecipe('llama-server')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models).toEqual([]);
    expect(r.touchpoints.embedding!.user_provided_models).toBe(true);
    expect(r.touchpoints.embedding!.default_dims).toBe(0);
  });

  test('declares a probe function', () => {
    const r = getRecipe('llama-server')!;
    expect(typeof r.probe).toBe('function');
  });

  test('probe returns ready=false with hint when no server listening on default port', async () => {
    // Use a guaranteed-unreachable port. withEnv ensures the prior value
    // (if any) is restored after the test, including across the
    // shared-process parallel test runner.
    await withEnv({ LLAMA_SERVER_BASE_URL: 'http://127.0.0.1:1/v1' }, async () => {
      const r = getRecipe('llama-server')!;
      const result = await r.probe!();
      expect(result.ready).toBe(false);
      expect(result.hint).toBeDefined();
      expect(result.hint!.toLowerCase()).toContain('llama-server');
    });
  });

  test('default auth: no env → "Bearer unauthenticated"', () => {
    const r = getRecipe('llama-server')!;
    const auth = defaultResolveAuth(r, {}, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer unauthenticated');
  });

  test('default auth: LLAMA_SERVER_API_KEY set → "Bearer <key>"', () => {
    const r = getRecipe('llama-server')!;
    const auth = defaultResolveAuth(r, { LLAMA_SERVER_API_KEY: 'sk-llama-fake' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer sk-llama-fake');
  });

  test('default auth: LLAMA_SERVER_BASE_URL alone does NOT become the Bearer (URL-shaped optional)', () => {
    const r = getRecipe('llama-server')!;
    const auth = defaultResolveAuth(
      r,
      { LLAMA_SERVER_BASE_URL: 'http://my-llama:8080/v1' },
      'embedding',
    );
    expect(auth.token).toBe('Bearer unauthenticated');
  });
});
