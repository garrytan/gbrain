/**
 * Particle recipe (GST-651): an OpenAI-compatible chat provider whose requests
 * name `particle-1` while responses report `particle-ai/particle-1`.
 *
 * Drives the real gateway against an intercepted fetch at Particle's default
 * base URL (no live calls) and asserts what leaves gbrain: the endpoint, the
 * bearer key, the model id, `reasoning_effort: 'none'` for a thinking-off
 * call, and that reasoning text never becomes answer text.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { chat, configureGateway, defaultResolveAuth, resetGateway } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { applyThinkingOff, thinkingOffMaxOutputTokens } from '../../src/core/ai/thinking-off.ts';
import { canonicalLookup } from '../../src/core/model-pricing.ts';

type Captured = { url: string; auth: string | null; body: any };
let captured: Captured[] = [];
let reply: Record<string, unknown> = {};
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.particle.ai/')) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    captured.push({ url, auth: headers.get('authorization'), body });
    return Response.json({
      id: 'chatcmpl_stub', object: 'chat.completion', created: 0, model: 'particle-ai/particle-1',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}', ...reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  resetGateway();
});

beforeEach(() => {
  captured = [];
  reply = {};
  resetGateway();
  configureGateway({ chat_model: 'particle:particle-1', env: { PARTICLE_API_KEY: 'fake-particle-key' } });
});

const ask = (model: string, extra: Record<string, unknown> = {}) => chat({
  model,
  messages: [{ role: 'user', content: 'score this' }],
  maxTokens: 2000,
  ...extra,
});

describe('recipe: particle', () => {
  test('registered with the expected OpenAI-compatible shape', () => {
    const r = getRecipe('particle');
    expect(r).toBeDefined();
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.particle.ai/v1');
    expect(r!.auth_env?.required).toEqual(['PARTICLE_API_KEY']);
    expect(r!.compat?.fetch).toBeUndefined();
    const c = r!.touchpoints.chat!;
    expect(c.models).toEqual(['particle-1', 'particle-ai/particle-1']);
    expect(c.supports_tools).toBe(true);
    expect(c.supports_subagent_loop).toBe(true);
    expect(c.supports_prompt_cache).toBe(true);
    expect(c.thinking_by_default).toBe(true);
    expect(c.max_context_tokens).toBe(1_048_576);
    expect(c.cost_per_1m_input_usd).toBe(0.25);
    expect(c.cost_per_1m_output_usd).toBe(1.00);
  });

  test('both model ids pass chat and expansion validation', () => {
    const r = getRecipe('particle')!;
    for (const id of ['particle-1', 'particle-ai/particle-1']) {
      expect(() => assertTouchpoint(r, 'chat', id)).not.toThrow();
      expect(() => assertTouchpoint(r, 'expansion', id)).not.toThrow();
    }
  });

  test('default auth: PARTICLE_API_KEY -> Bearer token; missing -> AIConfigError', () => {
    const r = getRecipe('particle')!;
    const auth = defaultResolveAuth(r, { PARTICLE_API_KEY: 'fake-particle-key' }, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-particle-key');
    expect(() => defaultResolveAuth(r, {}, 'chat')).toThrow(AIConfigError);
  });

  test('both ids price at $0.25 input and $1.00 output per 1M', () => {
    for (const id of ['particle:particle-1', 'particle:particle-ai/particle-1']) {
      expect(canonicalLookup(id)).toEqual({ input: 0.25, output: 1.00 });
    }
  });
});

describe('particle chat over Chat Completions', () => {
  test('posts to the default base URL with the bearer key and the requested model id', async () => {
    const res = await ask('particle:particle-1');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://api.particle.ai/v1/chat/completions');
    expect(captured[0]!.auth).toBe('Bearer fake-particle-key');
    expect(captured[0]!.body.model).toBe('particle-1');
    expect(captured[0]!.body.reasoning_effort).toBeUndefined();
    expect(res.text).toBe('{"ok":true}');
    expect(res.responseModel).toBe('particle-ai/particle-1');
  });

  test('the response-side id is accepted as the request model', async () => {
    await ask('particle:particle-ai/particle-1');

    expect(captured[0]!.body.model).toBe('particle-ai/particle-1');
  });

  test("thinking: 'off' sends reasoning_effort none and keeps the requested cap", async () => {
    await ask('particle:particle-1', { thinking: 'off' });

    expect(captured[0]!.body.reasoning_effort).toBe('none');
    expect(captured[0]!.body.max_tokens).toBe(2000);
    expect(applyThinkingOff({}, 'particle:particle-ai/particle-1')).toEqual({ particle: { reasoningEffort: 'none' } });
    expect(thinkingOffMaxOutputTokens('particle:particle-1', 2000, true, 16000)).toBe(2000);
  });

  test('reasoning_content stays out of the answer text', async () => {
    reply = { content: 'the answer', reasoning_content: 'private chain of thought' };
    expect((await ask('particle:particle-1')).text).toBe('the answer');

    reply = { content: '', reasoning_content: 'private chain of thought' };
    expect((await ask('particle:particle-1')).text).toBe('');
  });
});
