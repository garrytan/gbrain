/**
 * #6448 item 1 (fix wave 15 P6.1b) — the long-prompt tier row and its two
 * helpers: `priceAtPromptSize` (model-pricing.ts) and the tool-aware
 * `estimateChatInputTokens` (ai/chat-input-estimate.ts). Behaviour through the
 * cost APIs is pinned in test/model-pricing-long-context-tier.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  ANTHROPIC_LONG_PROMPT_THRESHOLD_TOKENS,
  CANONICAL_PRICING,
  canonicalLookup,
  priceAtPromptSize,
} from '../src/core/model-pricing.ts';
import { reservationCostUsd } from '../src/core/budget/reservation-cost.ts';
import { estimateChatInputTokens } from '../src/core/ai/chat-input-estimate.ts';

const HAIKU = 'anthropic:claude-haiku-5-5';
const T = ANTHROPIC_LONG_PROMPT_THRESHOLD_TOKENS;

describe('canonical row: Haiku 5.5 long-prompt tier', () => {
  const expectRates = (p: { input: number; output: number; cache_read?: number; cache_write?: number }, want: [number, number, number, number]) => {
    expect(p.input).toBeCloseTo(want[0], 12);
    expect(p.output).toBeCloseTo(want[1], 12);
    expect(p.cache_read).toBeCloseTo(want[2], 12);
    expect(p.cache_write).toBeCloseTo(want[3], 12);
  };
  const BASE: [number, number, number, number] = [0.10, 0.50, 0.01, 0.125];
  const TIER: [number, number, number, number] = [0.50, 2.50, 0.05, 0.625];

  test('the tier is declared at 5x every base rate above 100,000 tokens', () => {
    const row = CANONICAL_PRICING[HAIKU]!;
    expectRates(row, BASE);
    expect(row.long_prompt?.threshold_tokens).toBe(100_000);
    expectRates(row.long_prompt!, TIER);
  });

  test('priceAtPromptSize: 99,999 and exactly 100,000 are base; 100,001 is the tier (tier-free result)', () => {
    const row = canonicalLookup(HAIKU)!;
    expectRates(priceAtPromptSize(row, T - 1), BASE);
    expectRates(priceAtPromptSize(row, T), BASE);
    expect(priceAtPromptSize(row, T).long_prompt).toBeUndefined();
    expectRates(priceAtPromptSize(row, T + 1), TIER);
    expect(priceAtPromptSize(row, T + 1).long_prompt).toBeUndefined();
    expect(Object.keys(priceAtPromptSize(row, T + 1)).sort()).toEqual(['cache_read', 'cache_write', 'input', 'output']);
  });

  test('a row without a tier is returned as is, and a missing size prices at base', () => {
    const sonnet = canonicalLookup('anthropic:claude-sonnet-5-5')!;
    expect(priceAtPromptSize(sonnet, 5_000_000)).toBe(sonnet);
    expect(priceAtPromptSize(canonicalLookup(HAIKU)!, null).input).toBe(0.10);
    expect(priceAtPromptSize(canonicalLookup(HAIKU)!, Number.NaN).input).toBe(0.10);
  });
});

describe('pre-flight estimate counts tool schemas and tool results', () => {
  const system = 'x'.repeat(400);
  const schema = { type: 'object', properties: { slug: { type: 'string', description: 'y'.repeat(2_000) } } };

  test('tool definitions add to the estimate', () => {
    const without = estimateChatInputTokens({ system, messages: [{ content: 'hi' }] });
    const withTools = estimateChatInputTokens({ system, messages: [{ content: 'hi' }], tools: [{ name: 'put_page', description: 'write', inputSchema: schema }] });
    expect(without).toBe(Math.ceil(402 / 4));
    expect(withTools).toBeGreaterThanOrEqual(without + Math.floor(JSON.stringify(schema).length / 4));
  });

  test('tool-result output and tool-call input in the history add to the estimate; text blocks still count', () => {
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'z'.repeat(50) })) };
    const textOnly = estimateChatInputTokens({ messages: [{ content: [{ type: 'text', text: 'abcd'.repeat(10) }] }] });
    expect(textOnly).toBe(10);
    const withResult = estimateChatInputTokens({ messages: [
      { content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'search', input: { q: 'q'.repeat(400) } }] },
      { content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'search', output: big }] },
    ] });
    expect(withResult).toBeGreaterThanOrEqual(Math.floor((JSON.stringify(big).length + 400) / 4));
  });

  test('a long tool-heavy prompt crosses the threshold the way it will bill', () => {
    const output = 'w'.repeat(4 * (T + 10));
    const est = estimateChatInputTokens({ messages: [{ content: [{ type: 'tool-result', toolCallId: 't', toolName: 'read', output }] }] });
    expect(est).toBeGreaterThan(T);
    expect(reservationCostUsd(HAIKU, 'chat', est, 1_000)).toBeCloseTo((est * 0.50 + 1_000 * 2.50) / 1e6, 12);
  });
});
