/**
 * MiniMax recipe smoke (Commit 5 of the v0.32 wave).
 *
 * Coverage:
 *  - Recipe registered with expected shape
 *  - default auth: MINIMAX_API_KEY → "Bearer <key>"; missing → AIConfigError
 *  - dimsProviderOptions threads `type: 'db'` for embo-01 (the asymmetric
 *    retrieval field default) — pins the v1 indexing-only behavior
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import {
  applyAnthropicCompatAuth,
  applyAnthropicCompatConfig,
  defaultResolveAuth,
} from '../../src/core/ai/gateway.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { MINIMAX_ENDPOINTS } from '../../src/core/ai/recipes/minimax-shared.ts';

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

  test('chat touchpoint declares both target models and standard pricing', () => {
    const chat = getRecipe('minimax')!.touchpoints.chat!;
    expect(chat.models).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);
    expect(chat.supports_tools).toBe(true);
    expect(chat.supports_subagent_loop).toBe(true);
    expect(chat.max_context_tokens).toBeUndefined();
    expect(chat.cost_per_1m_input_usd).toBe(0.3);
    expect(chat.cost_per_1m_output_usd).toBe(1.2);
  });

  test('OpenAI-compatible recipe exposes both published regional base URLs', () => {
    expect(MINIMAX_ENDPOINTS.global_en.openai_base_url).toBe('https://api.minimax.io/v1');
    expect(MINIMAX_ENDPOINTS.cn_zh.openai_base_url).toBe('https://api.minimaxi.com/v1');
    expect(getRecipe('minimax')!.base_url_default).toBe(
      MINIMAX_ENDPOINTS.cn_zh.openai_base_url,
    );
  });

  test('Anthropic-compatible recipe preserves public regional base URLs', () => {
    const r = getRecipe('minimax-anthropic')!;
    expect(r.implementation).toBe('anthropic-compatible');
    expect(r.touchpoints.chat!.models).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);

    for (const publicBaseURL of [
      MINIMAX_ENDPOINTS.global_en.anthropic_base_url,
      MINIMAX_ENDPOINTS.cn_zh.anthropic_base_url,
    ]) {
      expect(publicBaseURL.endsWith('/anthropic')).toBe(true);
      expect(applyAnthropicCompatConfig(r, {
        base_urls: { [r.id]: publicBaseURL },
        env: {},
      })).toEqual({ baseURL: `${publicBaseURL}/v1` });
    }
  });

  test('Anthropic-compatible recipe maps the MiniMax key to Bearer auth', () => {
    const r = getRecipe('minimax-anthropic')!;
    expect(applyAnthropicCompatAuth(r, {
      env: { MINIMAX_API_KEY: 'fake-mm-key' },
    }, 'chat')).toEqual({ authToken: 'fake-mm-key' });
  });

  test('Anthropic-compatible recipe rejects a derived or unrelated public base URL', () => {
    const r = getRecipe('minimax-anthropic')!;
    expect(() => applyAnthropicCompatConfig(r, {
      base_urls: { [r.id]: `${MINIMAX_ENDPOINTS.global_en.anthropic_base_url}/v1` },
      env: {},
    })).toThrow(AIConfigError);
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

  test('dimsProviderOptions threads type:db for embo-01', () => {
    const opts = dimsProviderOptions('openai-compatible', 'embo-01', 1536);
    expect(opts).toEqual({ openaiCompatible: { type: 'db' } });
  });

  test('dimsProviderOptions returns undefined for non-MiniMax openai-compat models', () => {
    expect(dimsProviderOptions('openai-compatible', 'voyage-3-lite', 512)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768)).toBeUndefined();
  });
});
