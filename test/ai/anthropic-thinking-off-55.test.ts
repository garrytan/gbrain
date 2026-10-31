/**
 * Protect Claude 5.5's lowest supported thinking settings and output caps.
 * A blanket disabled recipe fails these assertions with a configured thinking
 * budget and max effort. Existing coverage exercises older Claude models.
 * Uses the real SDK with in-memory fetch; no production seam or network.
 */
import { expect, test } from 'bun:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { applyThinkingOff, thinkingOffMaxOutputTokens } from '../../src/core/ai/thinking-off.ts';

for (const [family, type, cap] of [
  ['sonnet', 'between_tools', 2000],
  ['opus', 'adaptive', 32000],
  ['haiku', 'disabled', 2000],
] as const) {
  for (const suffix of ['', '-20261001']) {
    test(`${family} 5.5${suffix} replaces incompatible settings and sends supported options`, async () => {
      const model = `claude-${family}-5-5${suffix}`;
      const route = `anthropic:${model}`;
      const options = applyThinkingOff({ anthropic: {
        thinking: { type: 'enabled', budgetTokens: 4000 },
        effort: 'max', cacheControl: { type: 'ephemeral' },
      } }, route);
      expect(options.anthropic).toEqual({
        thinking: { type }, effort: 'low', cacheControl: { type: 'ephemeral' },
      });
      const maxOutputTokens = thinkingOffMaxOutputTokens(route, 2000, true, 32000);
      expect(maxOutputTokens).toBe(cap);
      let body: any;
      const provider = createAnthropic({
        apiKey: 'stub',
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return Response.json({
            id: 'msg_stub', type: 'message', role: 'assistant', model,
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      });
      const result = await generateText({
        model: provider(model), prompt: 'Return ok.', providerOptions: options, maxOutputTokens,
      });
      expect(result.text).toBe('ok');
      expect(result.warnings).toEqual([]);
      expect(body.thinking).toEqual({ type });
      expect(body.output_config.effort).toBe('low');
      expect(body.max_tokens).toBe(cap);
    });
  }
}

test('older Anthropic and other routes preserve their controls', () => {
  for (const route of ['anthropic:claude-sonnet-4-6', 'anthropic:claude-opus-5', 'deepseek:deepseek-v4-flash']) {
    const namespace = route.split(':')[0]!;
    expect(applyThinkingOff({}, route)).toEqual({ [namespace]: { thinking: { type: 'disabled' } } });
    expect(thinkingOffMaxOutputTokens(route, 2000, true, 32000)).toBe(2000);
  }
  expect(applyThinkingOff({}, 'openrouter:anthropic/claude-opus-5.5')).toEqual({});
});
