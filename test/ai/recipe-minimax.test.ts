/**
 * MiniMax recipe smoke (Commit 5 of the v0.32 wave).
 *
 * Coverage:
 *  - Recipe registered with expected shape
 *  - default auth: MINIMAX_API_KEY → "Bearer <key>"; missing → AIConfigError
 *  - dimsProviderOptions threads `input_type` for embo-01 so the gateway's
 *    minimaxCompatFetch maps it to MiniMax's asymmetric `type: db|query` wire field
 *  - chat touchpoint declares MiniMax-M3 / M2.7 (OpenAI-compatible chat)
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: minimax', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('minimax');
    expect(r).toBeDefined();
    expect(r!.id).toBe('minimax');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.minimaxi.com/v1');
    expect(r!.auth_env?.required).toEqual(['MINIMAX_API_KEY']);
    expect(r!.auth_env?.optional).toContain('MINIMAX_GROUP_ID');
  });

  test('embedding touchpoint declares embo-01 + 1536 dims', () => {
    const r = getRecipe('minimax')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models).toEqual(['embo-01']);
    expect(r.touchpoints.embedding!.default_dims).toBe(1536);
    expect(r.touchpoints.embedding!.user_provided_models ?? false).toBe(false);
    expect(r.touchpoints.embedding!.max_batch_tokens).toBe(4096);
  });

  test('chat touchpoint declares MiniMax-M3 / M2.7 with tool support', () => {
    const r = getRecipe('minimax')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(false);
    expect(r.touchpoints.chat!.max_context_tokens).toBe(800000);
  });

  test('default auth: MINIMAX_API_KEY set → "Bearer <key>"', () => {
    const r = getRecipe('minimax')!;
    const auth = defaultResolveAuth(r, { MINIMAX_API_KEY: 'fake-mm-key' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-mm-key');
  });

  test('default auth: missing MINIMAX_API_KEY → AIConfigError', () => {
    const r = getRecipe('minimax')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });

  test('dimsProviderOptions threads input_type for embo-01 (asymmetric)', () => {
    // Default (no inputType threaded) → document-side, preserving the legacy
    // symmetric `type:'db'` semantics once minimaxCompatFetch maps it.
    expect(dimsProviderOptions('openai-compatible', 'embo-01', 1536)).toEqual({
      openaiCompatible: { input_type: 'document' },
    });
    // Query-side: embedQuery() threads 'query' → wire type:'query'.
    expect(dimsProviderOptions('openai-compatible', 'embo-01', 1536, 'query')).toEqual({
      openaiCompatible: { input_type: 'query' },
    });
    expect(dimsProviderOptions('openai-compatible', 'embo-01', 1536, 'document')).toEqual({
      openaiCompatible: { input_type: 'document' },
    });
  });

  test('dimsProviderOptions returns undefined for non-MiniMax openai-compat models', () => {
    expect(dimsProviderOptions('openai-compatible', 'voyage-3-lite', 512)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768)).toBeUndefined();
  });
});
