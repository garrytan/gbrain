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
import {
  openrouterSupportsPromptCache,
  liftMessageCacheControl,
  openrouterCacheControlFetch,
} from '../../src/core/ai/recipes/openrouter.ts';
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

  test('12. prompt cache capability is scoped to anthropic/claude-* routes (#1987)', () => {
    expect(openrouterSupportsPromptCache('anthropic/claude-sonnet-4.6')).toBe(true);
    expect(openrouterSupportsPromptCache('anthropic/claude-opus-4.7')).toBe(true);
    expect(openrouterSupportsPromptCache('ANTHROPIC/Claude-Haiku-4.5')).toBe(true); // case-insensitive
    expect(openrouterSupportsPromptCache('openai/gpt-5.2')).toBe(false);
    expect(openrouterSupportsPromptCache('deepseek/deepseek-chat')).toBe(false);
    expect(openrouterSupportsPromptCache('google/gemini-3-flash-preview')).toBe(false);
  });

  test('13. liftMessageCacheControl moves a message-level marker into the content part', () => {
    const body: any = {
      model: 'anthropic/claude-sonnet-4.6',
      messages: [
        { role: 'system', content: 'SYS', cache_control: { type: 'ephemeral' } },
        { role: 'user', content: 'hello' },
      ],
    };
    expect(liftMessageCacheControl(body)).toBe(true);
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
    });
    // The user message (no marker) is untouched.
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  test('14. liftMessageCacheControl is a no-op when no marker rides the body', () => {
    const body = {
      model: 'openai/gpt-5.2',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hello' },
      ],
    };
    expect(liftMessageCacheControl(body)).toBe(false);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(liftMessageCacheControl(undefined)).toBe(false);
    expect(liftMessageCacheControl({ input: 'embedding body, no messages' })).toBe(false);
  });

  test('15. cache fetch shim rewrites the outbound body and recomputes content-length', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await openrouterCacheControlFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-length': '999', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4.6',
          messages: [{ role: 'system', content: 'SYS', cache_control: { type: 'ephemeral' } }],
        }),
      });
      const rewritten = JSON.parse(calls[0].init!.body as string);
      expect(rewritten.messages[0].content).toEqual([
        { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
      ]);
      expect(rewritten.messages[0].cache_control).toBeUndefined();
      expect(new Headers(calls[0].init!.headers).get('content-length')).toBeNull();

      // Marker-free body passes through byte-identical (fail-open contract).
      const plain = JSON.stringify({ model: 'openai/gpt-5.2', messages: [{ role: 'user', content: 'hi' }] });
      await openrouterCacheControlFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: plain,
      });
      expect(calls[1].init!.body).toBe(plain);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('16. cache shim is installed as compat.chatFetch (chat path only, embedding shim preserved)', () => {
    const r = getRecipe('openrouter')!;
    expect(r.compat?.chatFetch).toBe(openrouterCacheControlFetch);
    // Deliberately NOT compat.fetch: that would displace the gateway's
    // asymmetric input_type shim on the embedding path.
    expect(r.compat?.fetch).toBeUndefined();
  });
});
