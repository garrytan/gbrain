/**
 * nan recipe smoke.
 *
 * Pins the recipe shape so the registry stays byte-stable:
 *  - id + tier + implementation + base_url
 *  - reranker touchpoint declares the `/v1/rerank` leaf (the whole point —
 *    nan.builders 404s on every other path) + `default_timeout_ms`
 *  - only live-verified model ids are listed
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: nan', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('nan');
    expect(r).toBeDefined();
    expect(r!.id).toBe('nan');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.nan.builders/v1');
    expect(r!.auth_env?.required).toEqual(['NAN_API_KEY']);
  });

  test('declares reranker touchpoint with /v1/rerank path + timeout', () => {
    const r = getRecipe('nan')!;
    const tp = r.touchpoints.reranker;
    expect(tp).toBeDefined();
    expect(tp!.path).toBe('/rerank');
    expect(tp!.default_timeout_ms).toBe(30_000);
    expect(tp!.max_payload_bytes).toBe(5_000_000);
  });

  test('base_url + path concatenation produces /v1/rerank, NOT /v1/v1/…', () => {
    const r = getRecipe('nan')!;
    const combined =
      r.base_url_default!.replace(/\/$/, '') + (r.touchpoints.reranker!.path ?? '/models/rerank');
    expect(combined).toBe('https://api.nan.builders/v1/rerank');
    expect(combined).not.toContain('/v1/v1/');
    expect(combined.endsWith('/rerank')).toBe(true);
  });

  test('lists only the live-verified model id', () => {
    const r = getRecipe('nan')!;
    const tp = r.touchpoints.reranker!;
    expect(tp.models).toEqual(['rerank']);
    expect(tp.default_model).toBe('rerank');
  });

  test('default auth: NAN_API_KEY set → Bearer token', () => {
    const r = getRecipe('nan')!;
    const auth = defaultResolveAuth(
      r,
      { NAN_API_KEY: 'nan-fake-key' },
      'reranker',
    );
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer nan-fake-key');
  });

  test('default auth: missing NAN_API_KEY → AIConfigError', () => {
    const r = getRecipe('nan')!;
    expect(() => defaultResolveAuth(r, {}, 'reranker')).toThrow(AIConfigError);
  });
});
