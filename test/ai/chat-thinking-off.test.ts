/**
 * #5331: `ChatOpts.thinking: 'off'` turns thinking off per call without the
 * call site knowing each provider's option shape.
 *
 * Drives the real gateway against a local stub of the Anthropic Messages and
 * OpenAI-compatible chat completions APIs and asserts the request body that
 * leaves gbrain, per route: native Anthropic (a configured thinking object is
 * replaced, cache control survives), DeepSeek, OpenRouter DeepSeek, a route
 * with no switch that does not think (unchanged), and a route with no switch
 * that thinks by default (keeps thinking, gets the thinking output headroom).
 *
 * W9F item 5: the per-model capability table for native Google (the
 * generateContent request is caught at `fetch`, since the Google route takes
 * no base URL) and native OpenAI (Responses API on the stub): a full off
 * switch keeps the requested cap, a floor gets the headroom, the two Google
 * thinking fields are never sent together, and a configured value under the
 * same key is replaced.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway, THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../../src/core/ai/gateway.ts';
import { applyThinkingOff } from '../../src/core/ai/thinking-off.ts';

let server: ReturnType<typeof Bun.serve>;
let bodies: any[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
  }) as typeof fetch;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
      if (new URL(req.url).pathname.endsWith('/responses')) {
        return Response.json({
          id: 'resp_stub', object: 'response', created_at: 0, status: 'completed', model: body.model,
          output: [{
            type: 'message', id: 'msg_stub', status: 'completed', role: 'assistant',
            content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
          }],
          incomplete_details: null,
          usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        });
      }
      if (new URL(req.url).pathname.endsWith('/messages')) {
        return Response.json({
          id: 'msg_stub', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: '{"ok":true}' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      return Response.json({
        id: 'chatcmpl_stub', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
  resetGateway();
});

beforeEach(() => {
  bodies = [];
  resetGateway();
});

function configure(model: string, providerChatOptions?: Record<string, Record<string, unknown>>): void {
  const base = `http://127.0.0.1:${server.port}/v1`;
  configureGateway({
    chat_model: model,
    env: {
      ANTHROPIC_API_KEY: 'stub', ANTHROPIC_BASE_URL: base,
      OPENAI_API_KEY: 'stub', OPENAI_BASE_URL: base, GOOGLE_GENERATIVE_AI_API_KEY: 'stub',
      DEEPSEEK_API_KEY: 'stub', OPENROUTER_API_KEY: 'stub', ZHIPUAI_API_KEY: 'stub', GROQ_API_KEY: 'stub',
    },
    base_urls: { deepseek: base, openrouter: base, zhipu: base, groq: base },
    ...(providerChatOptions ? { provider_chat_options: providerChatOptions } : {}),
  });
}

const judgeCall = (model: string, extra: Record<string, unknown> = {}) => chat({
  model,
  system: 'Return strict JSON.',
  messages: [{ role: 'user', content: 'score this' }],
  maxTokens: 2000,
  thinking: 'off',
  ...extra,
});

describe("chat({ thinking: 'off' }) request bodies (#5331)", () => {
  test('native Anthropic: a configured thinking budget is replaced, configured cache control survives', async () => {
    configure('anthropic:claude-sonnet-4-6', {
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 }, cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });

    await judgeCall('anthropic:claude-sonnet-4-6', { cacheSystem: true });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].thinking?.type).not.toBe('enabled');
    expect(JSON.stringify(bodies[0])).not.toContain('budget_tokens');
    expect(bodies[0].max_tokens).toBe(2000);
    expect(JSON.stringify(bodies[0].system)).toContain('"ttl":"1h"');
  });

  test('native Anthropic without the switch keeps the configured thinking budget', async () => {
    configure('anthropic:claude-sonnet-4-6', {
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 } },
    });

    await chat({ model: 'anthropic:claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }], maxTokens: 8000 });

    expect(bodies[0].thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
  });

  test('DeepSeek (thinks by default) gets its documented thinking switch', async () => {
    configure('deepseek:deepseek-v4-flash');

    await judgeCall('deepseek:deepseek-v4-flash');

    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(bodies[0].max_tokens).toBe(2000);
  });

  test('OpenRouter-hosted DeepSeek gets the same switch', async () => {
    configure('openrouter:deepseek/deepseek-v4-flash-0731');

    await judgeCall('openrouter:deepseek/deepseek-v4-flash-0731');

    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
  });

  test('a route with no switch that does not think is unchanged', async () => {
    configure('groq:llama-3.3-70b-versatile');

    await judgeCall('groq:llama-3.3-70b-versatile');

    expect('thinking' in bodies[0]).toBe(false);
    expect(bodies[0].max_tokens).toBe(2000);
  });

  test('a thinking-by-default model with no switch keeps thinking and gets the thinking output headroom', async () => {
    configure('zhipu:glm-5.3');

    await judgeCall('zhipu:glm-5.3');

    expect('thinking' in bodies[0]).toBe(false);
    expect(bodies[0].max_tokens).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });
});

describe("chat({ thinking: 'off' }) capability table: native Google and OpenAI (W9F item 5)", () => {
  const H = THINKING_MODEL_MAX_OUTPUT_TOKENS;
  const google: Array<[string, Record<string, unknown> | undefined, number]> = [
    ['gemini-2.5-flash', { thinkingBudget: 0 }, 2000],
    ['gemini-2.5-flash-lite', { thinkingBudget: 0 }, 2000],
    ['gemini-2.5-pro', { thinkingBudget: 128 }, H],
    ['gemini-3.8-flash', { thinkingLevel: 'low' }, H],
    ['gemini-3.7-flash', { thinkingLevel: 'low' }, H],
    ['gemini-3.6-flash', { thinkingLevel: 'minimal' }, H],
    ['gemini-3.5-flash', { thinkingLevel: 'minimal' }, H],
    ['gemini-3-flash-preview', { thinkingLevel: 'minimal' }, H],
    ['gemini-3.5-flash-lite', { thinkingLevel: 'minimal' }, H],
    ['gemini-3.1-pro-preview', { thinkingLevel: 'low' }, H],
    ['gemini-4-flash', undefined, H],
  ];
  for (const [model, thinkingConfig, cap] of google) {
    test(`google:${model} sends ${JSON.stringify(thinkingConfig ?? null)} at a ${cap}-token cap`, async () => {
      configure(`google:${model}`);

      await judgeCall(`google:${model}`);

      expect(bodies).toHaveLength(1);
      expect(bodies[0].generationConfig.thinkingConfig).toEqual(thinkingConfig);
      expect(bodies[0].generationConfig.maxOutputTokens).toBe(cap);
    });
  }

  test('a configured Google thinkingConfig is replaced, so the two thinking fields never meet', async () => {
    configure('google:gemini-2.5-flash', { google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } });

    await judgeCall('google:gemini-2.5-flash');

    expect(bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  test('a Google call without thinking off is unchanged', async () => {
    configure('google:gemini-2.5-flash');

    await chat({ model: 'google:gemini-2.5-flash', messages: [{ role: 'user', content: 'x' }], maxTokens: 2000 });

    expect(bodies[0].generationConfig.thinkingConfig).toBeUndefined();
    expect(bodies[0].generationConfig.maxOutputTokens).toBe(2000);
  });

  const openai: Array<[string, string | undefined, number]> = [
    ['gpt-5.2', 'none', 2000],
    ['gpt-5.4-mini', 'none', 2000],
    ['gpt-5.5', 'none', 2000],
    ['gpt-5.6-terra', 'none', 2000],
    ['gpt-5', 'minimal', H],
    ['gpt-5-mini', 'minimal', H],
    ['o3', 'low', H],
    ['gpt-6-sol', undefined, 2000],
    ['gpt-6-astra', undefined, 2000],
    ['gpt-5.5-pro', undefined, H],
    ['gpt-6.2-sol', undefined, 2000],
    ['gpt-5.2-chat-latest', undefined, 2000],
    ['gpt-4o-mini', undefined, 2000],
  ];
  for (const [model, effort, cap] of openai) {
    test(`openai:${model} sends reasoning effort ${effort ?? '(none set)'} at a ${cap}-token cap`, async () => {
      configure(`openai:${model}`);

      await judgeCall(`openai:${model}`);

      expect(bodies).toHaveLength(1);
      expect(bodies[0].reasoning?.effort).toBe(effort);
      expect(bodies[0].max_output_tokens).toBe(cap);
    });
  }

  test('OpenAI: a configured reasoning effort is replaced and the prompt cache key survives', async () => {
    configure('openai:gpt-5.2', { openai: { reasoningEffort: 'high' } });

    await judgeCall('openai:gpt-5.2');

    expect(bodies[0].reasoning).toEqual({ effort: 'none' });
    expect(typeof bodies[0].prompt_cache_key).toBe('string');
  });

  test('provider-options snapshot per model id: only native recipes get an option', () => {
    const snapshot = Object.fromEntries([
      'google:gemini-2.5-flash', 'google:gemini-2.5-pro', 'google:gemini-3.8-flash', 'google:gemini-3.6-flash',
      'google:gemini-flash-latest', 'google:gemini-2.0-flash', 'google:gemini-2.5-flash-preview-tts',
      'openai:gpt-5.2', 'openai:gpt-5', 'openai:gpt-6-astra', 'openai:gpt-4o-mini',
      'openrouter:openai/gpt-5.2', 'openrouter:google/gemini-2.5-flash', 'litellm:gemini-2.5-flash',
    ].map(m => [m, applyThinkingOff({}, m)]));
    expect(snapshot).toEqual({
      'google:gemini-2.5-flash': { google: { thinkingConfig: { thinkingBudget: 0 } } },
      'google:gemini-2.5-pro': { google: { thinkingConfig: { thinkingBudget: 128 } } },
      'google:gemini-3.8-flash': { google: { thinkingConfig: { thinkingLevel: 'low' } } },
      'google:gemini-3.6-flash': { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
      'google:gemini-flash-latest': {},
      'google:gemini-2.0-flash': {},
      'google:gemini-2.5-flash-preview-tts': {},
      'openai:gpt-5.2': { openai: { reasoningEffort: 'none' } },
      'openai:gpt-5': { openai: { reasoningEffort: 'minimal' } },
      'openai:gpt-6-astra': {},
      'openai:gpt-4o-mini': {},
      'openrouter:openai/gpt-5.2': {},
      'openrouter:google/gemini-2.5-flash': {},
      'litellm:gemini-2.5-flash': {},
    });
  });
});

describe('judge preflight estimates price the cap chat() sends (W9F item 5)', () => {
  const sentCap = (body: any): number => body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  test('takes-quality: each default panel model, and a route that keeps reasoning', async () => {
    const tq = await import('../../src/core/takes-quality-eval/runner.ts');
    const { estimateCost } = await import('../../src/core/takes-quality-eval/pricing.ts');
    const sent: Record<string, number> = {};
    for (const m of [...tq.DEFAULT_MODEL_PANEL, 'openai:gpt-5']) {
      bodies = [];
      configure(m);
      await judgeCall(m, { maxTokens: tq.JUDGE_MAX_TOKENS });
      sent[m] = sentCap(bodies[0]);
      expect(tq.judgeCallCostUsd(m)).toBe(estimateCost(m, 5000, sent[m]!));
    }
    expect(sent).toEqual({
      'openai:gpt-5.2': 2000,
      'anthropic:claude-opus-4-7': 2000,
      'google:gemini-2.5-flash': 2000,
      'openai:gpt-5': THINKING_MODEL_MAX_OUTPUT_TOKENS,
    });
  });

  test('cross-modal: each default slot, and a slot that keeps reasoning, named in the notes', async () => {
    const cm = await import('../../src/core/cross-modal-eval/runner.ts');
    const { canonicalLookup } = await import('../../src/core/model-pricing.ts');
    const sent: Record<string, number> = {};
    for (const slot of [...cm.DEFAULT_SLOTS, { id: 'X', model: 'openai:gpt-5' }]) {
      bodies = [];
      configure(slot.model);
      await judgeCall(slot.model, { maxTokens: 4000 });
      sent[slot.model] = sentCap(bodies[0]);
      const p = canonicalLookup(slot.model)!;
      const est = cm.estimateCost([slot], 1, 4000);
      expect(est.perCycleUSD).toBe(round2((5000 * p.input + sent[slot.model]! * p.output) / 1_000_000));
      expect(est.perCallTokens).toBe(5000 + sent[slot.model]!);
    }
    expect(sent).toEqual({
      'openai:gpt-5.2': 4000,
      'anthropic:claude-opus-4-7': 4000,
      'deepseek:deepseek-v4-pro': 4000,
      'openai:gpt-5': THINKING_MODEL_MAX_OUTPUT_TOKENS,
    });
    expect(cm.estimateCost([{ id: 'X', model: 'openai:gpt-5' }], 1, 4000).notes)
      .toEqual([`(openai:gpt-5): cannot turn thinking off; its calls send and are priced at a ${THINKING_MODEL_MAX_OUTPUT_TOKENS}-token output cap`]);
    expect(cm.estimateCost(cm.DEFAULT_SLOTS, 1, 4000).notes).toEqual([]);
  });
});
