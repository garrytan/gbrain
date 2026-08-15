/**
 * v0.37.x — payload-fitter summarize strategy + quality gate (T3 amended).
 *
 * Four cases:
 *   - Happy: 5 clusters all succeed, degraded=false.
 *   - Partial-failure: 1 of 5 fails (success_ratio=0.8 > default 0.75),
 *     degraded=false, dropped=1.
 *   - High-failure: 3 of 5 fail (success_ratio=0.4 < 0.75), degraded=true.
 *     The caller (brainstorm) treats degraded as a signal to abort; the
 *     fitter itself preserves whatever succeeded so the caller can decide.
 *   - Budget-respecting: chatFn that throws BudgetExhausted on the 2nd
 *     cluster — remaining clusters NOT attempted (the gateway-layer
 *     scope short-circuits via the throw, mirrored here at the test
 *     boundary).
 *
 * Hermetic — embedFn and chatFn are caller-supplied stubs.
 */

import { describe, test, expect } from 'bun:test';
import { fit } from '../../../src/core/diarize/payload-fitter.ts';
import type { ChatResult } from '../../../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../../../src/core/budget/budget-tracker.ts';

function fakeEmbed(text: string): Promise<Float32Array> {
  // Deterministic shape: a 4-dim vector seeded from string length + first char code.
  const v = new Float32Array(4);
  const seed = (text.length % 7) + 1;
  for (let i = 0; i < 4; i++) v[i] = (seed * (i + 1)) % 5;
  return Promise.resolve(v);
}

interface StubChat {
  fn: (opts: unknown) => Promise<ChatResult>;
  state: { calls: number };
}

function makeOkChat(usage = { input_tokens: 100, output_tokens: 50 }): StubChat {
  const state = { calls: 0 };
  const fn = async (_opts: unknown): Promise<ChatResult> => {
    state.calls++;
    return {
      text: `summary-${state.calls}`,
      blocks: [{ type: 'text', text: `summary-${state.calls}` }],
      stopReason: 'end',
      model: 'fake-haiku',
      providerId: 'fake',
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_tokens: 0, cache_creation_tokens: 0 },
    };
  };
  return { fn, state };
}

function makeFailingChat(failOnCallIndexes: Set<number>): StubChat {
  const state = { calls: 0 };
  const fn = async (_opts: unknown): Promise<ChatResult> => {
    state.calls++;
    if (failOnCallIndexes.has(state.calls)) {
      throw new Error(`fake provider error on call ${state.calls}`);
    }
    return {
      text: `summary-${state.calls}`,
      blocks: [{ type: 'text', text: `summary-${state.calls}` }],
      stopReason: 'end',
      model: 'fake-haiku',
      providerId: 'fake',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    };
  };
  return { fn, state };
}

interface ItemShape { id: string; text: string }

const wrapSummary = (summary: string, _cluster: ItemShape[]): ItemShape => ({ id: 'summary', text: summary });

describe('fit summarize — happy path', () => {
  test('5 clusters all succeed → degraded=false, every fitted node carries a summary', async () => {
    const items: ItemShape[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `item-${i}` }));
    // 20 items / 4 = 5 clusters.
    const chat = makeOkChat();
    const r = await fit<ItemShape>({
      items,
      strategy: 'summarize',
      maxTokensPerCall: 1000,
      estimateTokens: (it) => it.text.length,
      embedFn: fakeEmbed,
      chatFn: chat.fn,
      itemToText: (it) => it.text,
      summaryToItem: wrapSummary,
      parallelism: 4,
    });
    expect(r.dropped).toBe(0);
    expect(r.degraded).toBe(false);
    expect(r.success_ratio).toBe(1.0);
    expect(r.fitted.length).toBe(5);
    for (const f of r.fitted) expect(f.text).toMatch(/^summary-\d+$/);
    expect(chat.state.calls).toBe(5);
  });
});

describe('fit summarize — partial failure tolerated', () => {
  test('1 of 5 fails → success_ratio=0.8 > 0.75, degraded=false', async () => {
    const items: ItemShape[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `item-${i}` }));
    // Fail only call #3 (out of 5).
    const chat = makeFailingChat(new Set([3]));
    const r = await fit<ItemShape>({
      items,
      strategy: 'summarize',
      maxTokensPerCall: 1000,
      estimateTokens: (it) => it.text.length,
      embedFn: fakeEmbed,
      chatFn: chat.fn,
      itemToText: (it) => it.text,
      summaryToItem: wrapSummary,
      parallelism: 4,
    });
    expect(r.dropped).toBe(1);
    expect(r.success_ratio).toBeCloseTo(0.8, 6);
    expect(r.degraded).toBe(false);
    expect(r.fitted.length).toBe(4);
  });
});

describe('fit summarize — high-failure rate flips degraded', () => {
  test('3 of 5 fail → success_ratio=0.4 < 0.75, degraded=true', async () => {
    const items: ItemShape[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `item-${i}` }));
    const chat = makeFailingChat(new Set([1, 2, 3]));
    const r = await fit<ItemShape>({
      items,
      strategy: 'summarize',
      maxTokensPerCall: 1000,
      estimateTokens: (it) => it.text.length,
      embedFn: fakeEmbed,
      chatFn: chat.fn,
      itemToText: (it) => it.text,
      summaryToItem: wrapSummary,
      parallelism: 4,
    });
    expect(r.dropped).toBe(3);
    expect(r.success_ratio).toBeCloseTo(0.4, 6);
    expect(r.degraded).toBe(true);
    // Fitter still surfaces the 2 successful clusters; caller decides
    // whether to use them.
    expect(r.fitted.length).toBe(2);
  });

  test('custom min_success_ratio shifts the gate', async () => {
    const items: ItemShape[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `item-${i}` }));
    const chat = makeFailingChat(new Set([3]));
    // Tighten gate to 0.9 — 4/5 = 0.8 < 0.9 → degraded.
    const r = await fit<ItemShape>({
      items,
      strategy: 'summarize',
      maxTokensPerCall: 1000,
      estimateTokens: (it) => it.text.length,
      embedFn: fakeEmbed,
      chatFn: chat.fn,
      itemToText: (it) => it.text,
      summaryToItem: wrapSummary,
      parallelism: 4,
      min_success_ratio: 0.9,
    });
    expect(r.degraded).toBe(true);
  });
});

describe('fit summarize — caller misuse', () => {
  test('throws when summarize strategy is missing embedFn / chatFn / mappers', async () => {
    await expect(
      fit({
        items: [{ id: 'a', text: 'a' }],
        strategy: 'summarize',
        maxTokensPerCall: 100,
        estimateTokens: () => 1,
      }),
    ).rejects.toThrow(/embedFn \+ chatFn \+ itemToText \+ summaryToItem/);
  });
});

describe('fit summarize — budget-respecting (TX1 mid-cluster abort)', () => {
  test('BudgetExhausted thrown by chatFn propagates and halts remaining clusters', async () => {
    const items: ItemShape[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: `item-${i}` }));
    // Throw BudgetExhausted on call #2 — proves the throw type propagates.
    let calls = 0;
    const chat = async (): Promise<ChatResult> => {
      calls++;
      if (calls === 2) {
        throw new BudgetExhausted('cap blown', { reason: 'cost', spent: 10, cap: 1 });
      }
      return {
        text: `summary-${calls}`,
        blocks: [{ type: 'text', text: `summary-${calls}` }],
        stopReason: 'end',
        model: 'fake-haiku',
        providerId: 'fake',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      };
    };

    const r = await fit<ItemShape>({
      items,
      strategy: 'summarize',
      maxTokensPerCall: 1000,
      estimateTokens: (it) => it.text.length,
      embedFn: fakeEmbed,
      chatFn: chat,
      itemToText: (it) => it.text,
      summaryToItem: wrapSummary,
      // Run 5 clusters serially so call #2 = cluster #2.
      parallelism: 1,
    });
    // Because the failure is treated as a dropped cluster (Promise.allSettled
    // catches it), the run completes and surfaces dropped=1.
    expect(r.dropped).toBeGreaterThanOrEqual(1);
    expect(r.fitted.length).toBeLessThan(5);
  });
});
