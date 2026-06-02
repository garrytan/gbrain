/**
 * OpenAI Codex recipe contract (Commit 1).
 *
 * This file pins metadata only: the provider is registered and classified, but
 * must remain unavailable until later commits add the Codex auth/transport seam.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getRecipe, listRecipes } from '../../src/core/ai/recipes/index.ts';
import { envReady, formatRecipeTable } from '../../src/commands/providers.ts';
import {
  chat,
  configureGateway,
  isAvailable,
  probeChatModel,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

const missingCodexAuth = { codexAuth: { source: 'env' as const } };
const validCodexAuthSnapshot = {
  ok: true as const,
  source: 'env' as const,
  accessToken: 'fixture-token-not-real',
  tokenType: 'bearer' as const,
  expiresAtMs: Date.UTC(2030, 0, 1, 1, 0, 0),
  expiresAt: '2030-01-01T01:00:00.000Z',
};

afterEach(() => {
  resetGateway();
});

describe('recipe: openai-codex', () => {
  test('registered under a distinct Codex provider namespace', () => {
    const r = getRecipe('openai-codex');
    expect(r).toBeDefined();
    expect(r!.id).toBe('openai-codex');
    expect(r!.name).toBe('OpenAI Codex (ChatGPT plan)');
    expect(r!.tier).toBe('codex-responses');
    expect(r!.implementation).toBe('codex-responses');
    expect(r!.base_url_default).toBe('https://chatgpt.com/backend-api/codex');
    expect(r!.enforce_model_allowlist).toBe(true);
    expect(listRecipes().some(recipe => recipe.id === 'openai-codex')).toBe(true);
  });

  test('does not require or fall back to public OPENAI_API_KEY', () => {
    const r = getRecipe('openai-codex')!;
    expect(r.auth_env?.required).toEqual([]);
    expect(r.auth_env?.required).not.toContain('OPENAI_API_KEY');
    expect(r.auth_env?.optional ?? []).not.toContain('OPENAI_API_KEY');
    expect(r.auth_env?.optional).toContain('OPENAI_CODEX_ACCESS_TOKEN');
  });

  test('chat-only, text-only model metadata with no tools or subagent loop', () => {
    const r = getRecipe('openai-codex')!;
    expect(r.touchpoints.embedding).toBeUndefined();
    expect(r.touchpoints.expansion).toBeUndefined();
    expect(r.touchpoints.reranker).toBeUndefined();

    const chat = r.touchpoints.chat;
    expect(chat).toBeDefined();
    expect(chat!.models).toEqual(['gpt-5.5']);
    expect(chat!.supports_tools).toBe(false);
    expect(chat!.supports_subagent_loop).toBe(false);
    expect(chat!.supports_prompt_cache).toBe(false);
  });

  test('declares plan-billed public-API-spend metadata without metered zero rates', () => {
    const chat = getRecipe('openai-codex')!.touchpoints.chat!;
    expect(chat.cost_per_1m_input_usd).toBeUndefined();
    expect(chat.cost_per_1m_output_usd).toBeUndefined();
    expect(chat.billing).toEqual({
      mode: 'plan-billed',
      display: 'ChatGPT/Codex plan billing; public API spend is $0, subscription quota/rate limits still apply.',
      quota_hint: 'Subject to ChatGPT/Codex plan quotas and rate limits.',
    });
  });

  test('requires Codex-plan auth and never falls back to public OPENAI_API_KEY', () => {
    const r = getRecipe('openai-codex')!;
    expect(envReady(r, {}, missingCodexAuth)).toBe(false);
    expect(envReady(r, { OPENAI_API_KEY: 'sk-pub...odex' }, missingCodexAuth)).toBe(false);

    const out = formatRecipeTable([r], { OPENAI_API_KEY: 'sk-pub...odex' }, missingCodexAuth);
    const line = out.split('\n').find(row => row.startsWith('openai-codex'));
    expect(line).toBeDefined();
    expect(line).toContain('codex-responses');
    expect(line).toContain('✗ Codex auth unavailable');
    expect(line).not.toContain('✓ ready');
  });

  test('gateway availability and chat probe report pending Codex auth/transport', () => {
    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: {
        OPENAI_API_KEY: 'sk-pub...ount',
        OPENAI_CODEX_ACCESS_TOKEN: 'future-token-must-not-count-yet',
      },
      codex_auth_options: missingCodexAuth.codexAuth,
    });

    expect(isAvailable('chat')).toBe(false);
    expect(isAvailable('chat', 'openai-codex:gpt-5.5')).toBe(false);

    const probe = probeChatModel('openai-codex:gpt-5.5');
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.reason).toBe('unavailable');
      expect(probe.detail).toContain('Codex auth unavailable');
    }
  });

  test('chat throws a clear Codex pending error instead of unknown implementation', async () => {
    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: {},
      codex_auth: validCodexAuthSnapshot,
    });

    const promise = chat({
      messages: [{ role: 'user', content: 'Reply with just: pong' }],
      maxTokens: 16,
    });

    await expect(promise).rejects.toThrow(AIConfigError);
    await expect(
      chat({
        messages: [{ role: 'user', content: 'Reply with just: pong' }],
        maxTokens: 16,
      }),
    ).rejects.toThrow(/Codex Responses streaming transport is pending/);
  });
});
