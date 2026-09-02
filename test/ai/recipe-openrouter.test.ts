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
  OPENROUTER_CACHE_HEADER,
  openrouterCompatFetch,
  openrouterRequiresExplicitPromptCache,
  openrouterSupportsPromptCache,
} from '../../src/core/ai/recipes/openrouter.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint, embeddingDimsForModel } from '../../src/core/ai/model-resolver.ts';
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
    expect(e.dims_options).toEqual([512, 768, 1024, 1536]);
    expect(e.max_batch_tokens).toBe(300_000);
  });

  test('2b. #4114 — per-model dims for the documented catalog; unlisted ids resolve to 0 (explicit dims required)', () => {
    const r = getRecipe('openrouter')!;
    // Known catalog ids resolve to their live native width.
    expect(embeddingDimsForModel(r, 'openrouter:openai/text-embedding-3-small')).toBe(1536);
    expect(embeddingDimsForModel(r, 'openrouter:openai/text-embedding-3-large')).toBe(3072);
    expect(embeddingDimsForModel(r, 'openrouter:qwen/qwen3-embedding-8b')).toBe(4096);
    expect(embeddingDimsForModel(r, 'openrouter:bge-m3')).toBe(1024);
    expect(embeddingDimsForModel(r, 'openrouter:baai/bge-m3')).toBe(1024);
    // Unknown ids must NOT inherit a plausible-wrong 1536: 0 forces the
    // explicit --dim path (migrate embeddings throws its actionable error).
    expect(embeddingDimsForModel(r, 'openrouter:some/unknown-embedder')).toBe(0);
    expect(embeddingDimsForModel(r, 'openrouter:google/gemini-embedding-2-preview')).toBe(0);
    // Explicit override stays trusted for unlisted models.
    expect(r.touchpoints.embedding!.trust_custom_dims).toBe(true);
  });

  test('3. chat touchpoint accepts arbitrary provider/model IDs (openai-compat tier)', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    const loop = r.touchpoints.chat!.supports_subagent_loop;
    expect(typeof loop).toBe('function');
    if (typeof loop === 'function') {
      expect(loop('anthropic/claude-haiku-4.5')).toBe(true);
      expect(loop('anthropic/claude-sonnet-4.6')).toBe(true);
      expect(loop('deepseek/deepseek-v4-flash')).toBe(true);
      expect(loop('deepseek/deepseek-chat')).toBe(true);
      expect(loop('openai/gpt-5.2')).toBe(false);
      expect(loop('google/gemini-3-flash-preview')).toBe(false);
    }
    expect(() =>
      assertTouchpoint(r, 'chat', 'some/provider-model'),
    ).not.toThrow();
    expect(() =>
      assertTouchpoint(r, 'chat', 'meta-llama/llama-future-2030'),
    ).not.toThrow();
  });

  test('3b. expansion reuses routed chat models and accepts arbitrary provider/model IDs', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.expansion).toBeDefined();
    expect(r.touchpoints.expansion!.models.length).toBeGreaterThanOrEqual(3);
    expect(() =>
      assertTouchpoint(r, 'expansion', 'some/provider-model'),
    ).not.toThrow();
    expect(() =>
      assertTouchpoint(r, 'expansion', 'meta-llama/llama-future-2030'),
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

  // 12-15 — prompt caching (takeover of PR #1988).

  test('12. prompt cache capability is family-scoped, not a blanket claim', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(openrouterSupportsPromptCache);

    expect(openrouterSupportsPromptCache('openai/gpt-5.2')).toBe(true);
    expect(openrouterSupportsPromptCache('openai/gpt-5.2-chat')).toBe(true);
    expect(openrouterSupportsPromptCache('openai/o4-mini')).toBe(true);
    expect(openrouterSupportsPromptCache('openai/text-embedding-3-small')).toBe(false);
    expect(openrouterSupportsPromptCache('anthropic/claude-sonnet-4.6')).toBe(true);
    expect(openrouterSupportsPromptCache('anthropic/claude-opus-4.7')).toBe(true);
    // DeepSeek routes cache automatically, same as the OpenAI ones — and the
    // native `deepseek` recipe says so too, so the two routes must agree.
    expect(openrouterSupportsPromptCache('deepseek/deepseek-chat')).toBe(true);
    expect(openrouterSupportsPromptCache('google/gemini-3-flash-preview')).toBe(false);

    // Routing variants (`:online`, `:nitro`, `:floor`, …) are an OpenRouter
    // concept, not part of the upstream model id, so they must not change the
    // answer either way.
    expect(openrouterSupportsPromptCache('openai/gpt-4o:online')).toBe(true);
    expect(openrouterSupportsPromptCache('openai/gpt-4.1:nitro')).toBe(true);
    expect(openrouterSupportsPromptCache('openai/o1:floor')).toBe(true);
    expect(openrouterSupportsPromptCache('openai/gpt-4-turbo:online')).toBe(false);
    expect(openrouterSupportsPromptCache('deepseek/deepseek-chat:free')).toBe(true);
  });

  test('13. only Anthropic Claude routes require the explicit cache_control rewrite', () => {
    expect(openrouterRequiresExplicitPromptCache('anthropic/claude-sonnet-4.6')).toBe(true);
    expect(openrouterRequiresExplicitPromptCache('openai/gpt-5.2')).toBe(false);
    expect(openrouterRequiresExplicitPromptCache('deepseek/deepseek-chat')).toBe(false);
  });

  test('14. recipe installs the cache compat fetch shim', () => {
    const r = getRecipe('openrouter')!;
    expect(r.compat?.fetch).toBe(openrouterCompatFetch);
  });

  test('15. fetch shim rewrites system content-block cache_control for Claude routes and always strips the marker header', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const post = (model: string, withMarker: boolean) =>
        openrouterCompatFetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: withMarker ? { [OPENROUTER_CACHE_HEADER]: '1' } : {},
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'stable system prompt' },
              { role: 'user', content: 'hello' },
            ],
          }),
        });

      // Marker + Claude route → system content becomes a cache_control block.
      await post('anthropic/claude-sonnet-4.6', true);
      const rewritten = JSON.parse(calls[0].init!.body as string);
      expect(rewritten.messages[0].content).toEqual([
        { type: 'text', text: 'stable system prompt', cache_control: { type: 'ephemeral' } },
      ]);
      expect(rewritten.messages[1]).toEqual({ role: 'user', content: 'hello' });
      // Marker never leaves the process.
      expect(new Headers(calls[0].init!.headers as any).has(OPENROUTER_CACHE_HEADER)).toBe(false);

      // Marker + non-Claude route → body untouched, marker still stripped.
      await post('openai/gpt-5.2', true);
      const untouched = JSON.parse(calls[1].init!.body as string);
      expect(untouched.messages[0]).toEqual({ role: 'system', content: 'stable system prompt' });
      expect(new Headers(calls[1].init!.headers as any).has(OPENROUTER_CACHE_HEADER)).toBe(false);

      // No marker → body untouched even on a Claude route.
      await post('anthropic/claude-sonnet-4.6', false);
      const noMarker = JSON.parse(calls[2].init!.body as string);
      expect(noMarker.messages[0]).toEqual({ role: 'system', content: 'stable system prompt' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('16. fetch shim promotes reasoning_content when content is empty (DeepSeek-via-OpenRouter, #4753)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'the answer' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    try {
      const res = await openrouterCompatFetch('https://openrouter.ai/api/v1/chat/completions');
      const json = await res.json();
      expect(json.choices[0].message.content).toBe('the answer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('17. fetch shim does not promote on tool-call turns or non-empty content', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const kind = body.includes('tool') ? 'tool' : 'content';
      if (kind === 'tool') {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'tool_calls', message: {
            content: null,
            reasoning_content: 'INTERNAL CHAIN OF THOUGHT — must not leak',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'brain_search', arguments: '{}' } }],
          } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'real content', reasoning_content: 'ignored' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const toolRes = await openrouterCompatFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash-0731', kind: 'tool' }),
      });
      const toolJson = await toolRes.json();
      expect(toolJson.choices[0].message.content).toBeNull();
      expect(toolJson.choices[0].message.tool_calls).toHaveLength(1);

      const textRes = await openrouterCompatFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash-0731' }),
      });
      expect((await textRes.json()).choices[0].message.content).toBe('real content');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('18. cache_control rewrite still runs, then reasoning_content is promoted on the response', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '   ', reasoning_content: 'from ws' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const res = await openrouterCompatFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { [OPENROUTER_CACHE_HEADER]: '1' },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4.6',
          messages: [
            { role: 'system', content: 'stable system prompt' },
            { role: 'user', content: 'hello' },
          ],
        }),
      });
      const rewritten = JSON.parse(calls[0].init!.body as string);
      expect(rewritten.messages[0].content).toEqual([
        { type: 'text', text: 'stable system prompt', cache_control: { type: 'ephemeral' } },
      ]);
      expect(new Headers(calls[0].init!.headers as any).has(OPENROUTER_CACHE_HEADER)).toBe(false);
      expect((await res.json()).choices[0].message.content).toBe('from ws');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('19. non-JSON body + marker: body forwarded unchanged, marker stripped, and the reasoning_content promote still composes', async () => {
    // Fail-open request path: a body the shim cannot parse is sent as-is
    // (the provider surfaces its own error), the in-process marker header
    // must STILL never leave the process, and the response-side promote is
    // composed regardless of the request-side parse failure (#4753).
    const originalFetch = globalThis.fetch;
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'x' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const rawBody = 'this is not json {';
      const res = await openrouterCompatFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { [OPENROUTER_CACHE_HEADER]: '1', 'content-length': String(rawBody.length) },
        body: rawBody,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].init!.body).toBe(rawBody);
      const forwarded = new Headers(calls[0].init!.headers as any);
      expect(forwarded.has(OPENROUTER_CACHE_HEADER)).toBe(false);
      // Body untouched → the caller's content-length is still truthful and kept.
      expect(forwarded.get('content-length')).toBe(String(rawBody.length));
      expect((await res.json()).choices[0].message.content).toBe('x');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('20. marker without any body (GET-shaped init) still strips the marker and promotes', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'x' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const res = await openrouterCompatFetch('https://openrouter.ai/api/v1/chat/completions', {
        headers: { [OPENROUTER_CACHE_HEADER]: '1' },
      });
      expect(calls[0].init!.body).toBeUndefined();
      expect(new Headers(calls[0].init!.headers as any).has(OPENROUTER_CACHE_HEADER)).toBe(false);
      expect((await res.json()).choices[0].message.content).toBe('x');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
