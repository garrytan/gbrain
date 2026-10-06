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
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway, THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../../src/core/ai/gateway.ts';

let server: ReturnType<typeof Bun.serve>;
let bodies: any[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
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
