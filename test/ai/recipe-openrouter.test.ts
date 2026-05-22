/**
 * OpenRouter recipe smoke + shape regression (v0.37.2.0).
 *
 * Replaces the PR #1210 5-case smoke with a wider sweep:
 *   1-5  recipe shape + auth (PR baseline)
 *   6-7  arbitrary-ID acceptance + chat/embedding model-shape regression (D5
 *        codex correction — never pin specific slugs)
 *   8-10 resolveDefaultHeaders default + env-override paths (D4)
 *   11   setup_hint references the required + optional env vars
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

// D5 shape regex: provider/model slug, allowing letters, digits, dots, hyphens,
// underscores in the model portion. Matches real OR catalog IDs like
// `openai/gpt-5.2-chat`, `anthropic/claude-haiku-4.5`, `deepseek/deepseek-chat`.
const MODEL_SHAPE = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

describe('recipe: openrouter', () => {
  test('1. registered with expected shape', () => {
    const r = getRecipe('openrouter');
    expect(r).toBeDefined();
    expect(r!.id).toBe('openrouter');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://openrouter.ai/api/v1');
    expect(r!.auth_env?.required).toEqual(['OPENROUTER_API_KEY']);
    expect(r!.auth_env?.optional).toContain('OPENROUTER_BASE_URL');
    expect(r!.auth_env?.optional).toContain('OPENROUTER_REFERER');
    expect(r!.auth_env?.optional).toContain('OPENROUTER_TITLE');
  });

  test('2. embedding touchpoint declares Matryoshka dims + 300K aggregate budget', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.embedding).toBeDefined();
    const e = r.touchpoints.embedding!;
    expect(e.models[0]).toBe('openai/text-embedding-3-small');
    expect(e.default_dims).toBe(1536);
    expect(e.dims_options).toEqual([512, 768, 1024, 1536]);
    expect(e.max_batch_tokens).toBe(300_000);
  });

  test('3. chat touchpoint accepts arbitrary provider/model IDs (openai-compat tier)', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    // supports_subagent_loop is informational; isAnthropicProvider() is the
    // real gate. Field stays false per the recipe docstring.
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(() =>
      assertTouchpoint(r, 'chat', 'some/provider-model'),
    ).not.toThrow();
    expect(() =>
      assertTouchpoint(r, 'chat', 'meta-llama/llama-future-2030'),
    ).not.toThrow();
  });

  test('4. chat models list — every entry matches provider/model shape (D5 regression)', () => {
    // Codex correction: pinning specific slugs creates false confidence (the
    // list is advisory; OR's catalog churns). The shape test catches the
    // failure modes that matter — typos, malformed IDs, dropped slashes,
    // uppercase pollution — without locking us into the catalog's churn rate.
    const r = getRecipe('openrouter')!;
    const models = r.touchpoints.chat!.models;
    expect(models.length).toBeGreaterThanOrEqual(6);
    for (const m of models) {
      expect(m, `chat model "${m}" must match provider/model shape`).toMatch(
        MODEL_SHAPE,
      );
    }
  });

  test('5. embedding models list — every entry matches provider/model shape', () => {
    const r = getRecipe('openrouter')!;
    const models = r.touchpoints.embedding!.models;
    expect(models.length).toBeGreaterThanOrEqual(1);
    for (const m of models) {
      expect(m, `embedding model "${m}" must match provider/model shape`).toMatch(
        MODEL_SHAPE,
      );
    }
  });

  test('6. no max_context_tokens declared (mixed catalog, per-model varies)', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.chat!.max_context_tokens).toBeUndefined();
  });

  test('7. defaultResolveAuth with OPENROUTER_API_KEY returns Bearer header', () => {
    const r = getRecipe('openrouter')!;
    const auth = defaultResolveAuth(
      r,
      { OPENROUTER_API_KEY: 'sk-or-fake' },
      'embedding',
    );
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer sk-or-fake');
  });

  test('8. missing OPENROUTER_API_KEY throws AIConfigError', () => {
    const r = getRecipe('openrouter')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });

  test('9. resolveDefaultHeaders with no env returns gbrain defaults', () => {
    const r = getRecipe('openrouter')!;
    expect(r.resolveDefaultHeaders).toBeDefined();
    const h = r.resolveDefaultHeaders!({});
    expect(h['HTTP-Referer']).toBe('https://gbrain.ai');
    expect(h['X-OpenRouter-Title']).toBe('gbrain');
    // Back-compat alias documented as still-supported.
    expect(h['X-Title']).toBe('gbrain');
  });

  test('10. resolveDefaultHeaders honors OPENROUTER_REFERER + OPENROUTER_TITLE (fork override path)', () => {
    const r = getRecipe('openrouter')!;
    const h = r.resolveDefaultHeaders!({
      OPENROUTER_REFERER: 'https://agent-fork.example',
      OPENROUTER_TITLE: 'agent-fork',
    });
    expect(h['HTTP-Referer']).toBe('https://agent-fork.example');
    expect(h['X-OpenRouter-Title']).toBe('agent-fork');
    expect(h['X-Title']).toBe('agent-fork');
  });

  test('11. setup_hint references required + optional env vars', () => {
    const r = getRecipe('openrouter')!;
    expect(r.setup_hint).toBeDefined();
    expect(r.setup_hint).toContain('OPENROUTER_API_KEY');
    expect(r.setup_hint).toContain('OPENROUTER_BASE_URL');
    expect(r.setup_hint).toContain('OPENROUTER_REFERER');
    expect(r.setup_hint).toContain('OPENROUTER_TITLE');
  });
});
