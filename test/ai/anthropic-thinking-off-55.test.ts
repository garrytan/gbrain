/**
 * #7567: `thinking: 'off'` on a native Claude 5.5 route sends that model's
 * lowest supported thinking setting with effort low, not the blanket
 * `{ type: 'disabled' }` (a 400 on Sonnet 5.5, valid on Haiku 5.5 only at
 * effort high or below). A configured budget or effort is replaced and
 * sibling options survive. Opus 5.5 keeps the older row until its pricing
 * against the fence-repair caps is decided. The wire check goes
 * through the real @ai-sdk/anthropic with a stub fetch: no network, no key.
 */
import { describe, expect, test } from 'bun:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { applyThinkingOff, thinkingOffControl, thinkingOffMaxOutputTokens } from '../../src/core/ai/thinking-off.ts';

const REQUESTED = 1500;
const HEADROOM = 32000;
const configured = () => ({ anthropic: { thinking: { type: 'enabled', budgetTokens: 8000 }, effort: 'xhigh', cacheControl: { type: 'ephemeral', ttl: '1h' } } });

const rows = [
  { model: 'claude-sonnet-5-5', thinking: 'between_tools', disables: true },
  { model: 'claude-sonnet-5-5-20261015', thinking: 'between_tools', disables: true },
  { model: 'claude-haiku-5-5', thinking: 'disabled', disables: true },
  { model: 'claude-haiku-5-5-20261015', thinking: 'disabled', disables: true },
];

async function sentBody(model: string, providerOptions: Record<string, any>, maxOutputTokens: number) {
  let sent: Record<string, any> = {};
  const anthropic = createAnthropic({
    apiKey: 'test-key-not-real',
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 3, output_tokens: 1 } });
    }) as typeof fetch,
  });
  const { warnings } = await generateText({ model: anthropic(model), prompt: 'Say done.', providerOptions, maxOutputTokens });
  return { sent, warnings };
}

describe('Claude 5.5 thinking-off controls (#7567)', () => {
  for (const row of rows) {
    test(`${row.model}: ${row.thinking} at effort low, sent without an SDK rewrite`, async () => {
      const route = `anthropic:${row.model}`;
      expect(thinkingOffControl(route)?.disables).toBe(row.disables);
      const options = applyThinkingOff(configured(), route);
      expect(options).toEqual({ anthropic: { thinking: { type: row.thinking }, effort: 'low', cacheControl: { type: 'ephemeral', ttl: '1h' } } });
      const cap = thinkingOffMaxOutputTokens(route, REQUESTED, true, HEADROOM);
      expect(cap).toBe(REQUESTED);
      const { sent, warnings } = await sentBody(row.model, options, cap);
      expect(warnings).toEqual([]);
      expect(sent.thinking).toEqual({ type: row.thinking });
      expect(sent.output_config).toEqual({ effort: 'low' });
      expect(sent.max_tokens).toBe(cap);
    });
  }

  test('older Claude, DeepSeek and non-native Claude routes keep their behavior', () => {
    for (const route of ['anthropic:claude-opus-5-5', 'anthropic:claude-opus-5', 'anthropic:claude-sonnet-4-6', 'anthropic:claude-haiku-4-5-20251001', 'anthropic:claude-sonnet-5-5-preview']) {
      expect(applyThinkingOff({}, route)).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
      expect(thinkingOffMaxOutputTokens(route, REQUESTED, true, HEADROOM)).toBe(REQUESTED);
    }
    expect(applyThinkingOff({}, 'deepseek:deepseek-v4-flash')).toEqual({ deepseek: { thinking: { type: 'disabled' } } });
    expect(applyThinkingOff({}, 'openrouter:anthropic/claude-sonnet-5.5')).toEqual({});
  });
});
