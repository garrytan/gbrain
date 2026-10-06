/**
 * Eng I6: reservation identity. `reserve()` returns an opaque id and the call
 * that made it settles it, by id, through `record()` or `release()`.
 *
 * Pre-fix, settlement popped the OLDEST outstanding projection for the
 * recorded model (FIFO by model, falling back to any same-kind entry). Two
 * concurrent same-model calls of different sizes therefore freed the large
 * call's hold when the small one finished first, and a third large call was
 * admitted past the cap while the first was still in flight. An attempt that
 * never reached the provider (provider resolution failed, an invocation
 * policy refused it) was never settled at all, leaking its hold for the
 * tracker's lifetime, or (policy refusal on the test lane) was charged the
 * pessimistic failure usage.
 *
 * Hermetic: tmp audit path; the gateway runs through __setChatTransportForTests.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExhausted, BudgetTracker, _resetBudgetTrackerWarningsForTest } from '../../../src/core/budget/budget-tracker.ts';
import { chat, withBudgetTracker, __setChatTransportForTests, type ChatOpts, type ChatResult } from '../../../src/core/ai/gateway.ts';
import { withAIInvocationGuard } from '../../../src/core/ai/invocation-guard.ts';

const MODEL = 'anthropic:claude-haiku-4-5-20251001'; // $1 in / $5 out per 1M
const LARGE = 100_000; // $0.50 of output ceiling
const SMALL = 1_000; // $0.005

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-reservation-'));
  _resetBudgetTrackerWarningsForTest();
});
afterEach(() => {
  __setChatTransportForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

const tracker = (cap = 1) => new BudgetTracker({ label: 'test.reservation', auditPath: join(tmp, 'a.jsonl'), maxCostUsd: cap });
const est = (maxOutputTokens: number, modelId = MODEL) => ({ modelId, kind: 'chat' as const, estimatedInputTokens: 0, maxOutputTokens });

function result(model: string, output: number): ChatResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    model,
    providerId: 'anthropic',
    usage: { input_tokens: 0, output_tokens: output, cache_read_tokens: 0, cache_creation_tokens: 0 },
  };
}

describe('BudgetTracker settles reservations by id', () => {
  test('a small call settling first keeps the large in-flight hold; a third large call is refused', () => {
    const t = tracker();
    const large = t.reserve(est(LARGE));
    const small = t.reserve(est(SMALL));
    expect(large).toBeDefined();
    expect(small).toBeDefined();
    t.record({ modelId: MODEL, kind: 'chat', inputTokens: 0, outputTokens: 100, reservation: small });
    expect(() => t.reserve(est(LARGE))).toThrow(BudgetExhausted);
    t.record({ modelId: MODEL, kind: 'chat', inputTokens: 0, outputTokens: 100, reservation: large });
    expect(() => t.reserve(est(LARGE))).not.toThrow();
  });

  test('an alias reservation is settled by the served id record', () => {
    const t = tracker();
    const r = t.reserve(est(LARGE * 1.8, 'claude-cli:haiku'));
    expect(r).toBeDefined();
    t.record({ modelId: 'claude-cli:claude-haiku-4-5-20251001', kind: 'chat', inputTokens: 0, outputTokens: 0, reservation: r });
    expect(() => t.reserve(est(LARGE * 1.8))).not.toThrow();
  });

  test('release frees an unbilled hold once; a settled or undefined id is a no-op', () => {
    const t = tracker();
    const r = t.reserve(est(LARGE * 1.8));
    t.release(r);
    t.release(r);
    t.release(undefined);
    const r2 = t.reserve(est(LARGE * 1.8));
    t.record({ modelId: MODEL, kind: 'chat', inputTokens: 0, outputTokens: 0, reservation: r2 });
    t.release(r2);
    expect(() => t.reserve(est(LARGE * 1.8))).not.toThrow();
  });

  test('a record without a reservation (expand/OCR sites) settles no one else\'s hold', () => {
    const t = tracker();
    t.reserve(est(LARGE));
    t.record({ modelId: MODEL, kind: 'chat', inputTokens: 0, outputTokens: 0 });
    expect(() => t.reserve(est(LARGE * 1.2))).toThrow(BudgetExhausted);
  });

  test('a priced reservation recorded under an unpriced served id charges the held ceiling', () => {
    const t = tracker();
    const r = t.reserve(est(LARGE));
    t.record({ modelId: 'stub:served-under-another-name', kind: 'chat', inputTokens: 0, outputTokens: 10, reservation: r });
    expect(t.totalSpent).toBeCloseTo(0.5, 9);
    expect(() => t.reserve(est(LARGE * 1.2))).toThrow(BudgetExhausted);
  });

  test('uncapped and unpriced reservations hold nothing and return no id', () => {
    expect(new BudgetTracker({ label: 'x', auditPath: join(tmp, 'b.jsonl') }).reserve(est(LARGE))).toBeUndefined();
    expect(new BudgetTracker({ label: 'x', auditPath: join(tmp, 'b.jsonl'), maxCostUsd: 1, capSource: 'default' })
      .reserve(est(LARGE, 'mystery:unpriced'))).toBeUndefined();
  });
});

describe('gateway.chat settles every admitted attempt', () => {
  test('concurrent large + small same-model calls: small finishes first, a third large call is refused', async () => {
    const t = tracker();
    const gates: Record<string, () => void> = {};
    __setChatTransportForTests(async (opts: ChatOpts) => {
      const key = String(opts.maxTokens);
      if (!gates[key]) await new Promise<void>((resolve) => { gates[key] = resolve; });
      return result(MODEL, 100);
    });
    await withBudgetTracker(t, async () => {
      const large = chat({ model: MODEL, maxTokens: LARGE, messages: [{ role: 'user', content: 'a' }] });
      const small = chat({ model: MODEL, maxTokens: SMALL, messages: [{ role: 'user', content: 'b' }] });
      while (!gates[String(LARGE)] || !gates[String(SMALL)]) await new Promise((r) => setTimeout(r, 1));
      gates[String(SMALL)]!();
      await small;
      await expect(chat({ model: MODEL, maxTokens: LARGE, messages: [{ role: 'user', content: 'c' }] })).rejects.toBeInstanceOf(BudgetExhausted);
      gates[String(LARGE)]!();
      await large;
    });
  });

  test('an invocation policy refusal is released, not charged', async () => {
    const t = tracker();
    __setChatTransportForTests(async () => result(MODEL, 100));
    await withBudgetTracker(t, async () => {
      await expect(withAIInvocationGuard(async () => { throw new Error('policy refused'); }, () =>
        chat({ model: MODEL, maxTokens: LARGE * 1.8, messages: [{ role: 'user', content: 'a' }] }))).rejects.toThrow('policy refused');
    });
    expect(t.totalSpent).toBe(0);
    expect(() => t.reserve(est(LARGE * 1.8))).not.toThrow();
  });

  test('a provider-resolution failure releases the hold', async () => {
    const t = new BudgetTracker({
      label: 'test.reservation', auditPath: join(tmp, 'a.jsonl'), maxCostUsd: 1,
      pricingOverrides: { 'no-such-provider:model': { input: 0, output: 5 } },
    });
    await withBudgetTracker(t, async () => {
      await expect(chat({ model: 'no-such-provider:model', maxTokens: LARGE * 1.8, messages: [{ role: 'user', content: 'a' }] })).rejects.toThrow();
    });
    expect(() => t.reserve(est(LARGE * 1.8))).not.toThrow();
  });

  test('an aborted provider call is charged its failure usage and settles its own hold', async () => {
    const t = tracker();
    __setChatTransportForTests(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError', usage: { input_tokens: 0, output_tokens: 10 } }); });
    await withBudgetTracker(t, async () => {
      await expect(chat({ model: MODEL, maxTokens: LARGE * 1.8, messages: [{ role: 'user', content: 'a' }] })).rejects.toThrow('aborted');
    });
    expect(t.totalSpent).toBeCloseTo(10 * 5 / 1_000_000, 12);
    expect(() => t.reserve(est(LARGE * 1.8))).not.toThrow();
  });
});
