import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { configureGateway, resetGateway, embed, withBudgetTracker, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { embedRequestBudgetInputTokens } from '../src/core/ai/embed-batch-plan.ts';
import { voyage } from '../src/core/ai/recipes/voyage.ts';
import { configuredEmbeddingCapUsd, withEmbeddingBudget } from '../src/core/embedding-budget.ts';

const dims = 256;
const configure = () => configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: dims, env: { VOYAGE_API_KEY: 'fake' } });
const config = (cap: string | null) => ({ getConfig: async (key: string) => key === 'embed.backfill_max_usd' ? cap : null });
const vectors = (values: string[]) => values.map(() => Array.from({ length: dims }, () => 0.1));

afterEach(() => { __setEmbedTransportForTests(null); resetGateway(); });

describe('embedding run admission and settlement', () => {
  test('provider context, not bytes or batching target, bounds normalized text', () => {
    expect(embedRequestBudgetInputTokens(['你好', '\uFDFA', 'e\u0301'], voyage, 'voyage-4')).toBe(98_304);
    expect(embedRequestBudgetInputTokens(Array.from({ length: 4000 }, () => 'x'), voyage, 'voyage-4', 2048)).toBe(240_000);
  });

  test('nested caps reserve in both ledgers, release denied holds and charge measured usage', async () => {
    configure();
    let calls = 0;
    let retries: number | undefined;
    __setEmbedTransportForTests(async ({ values, maxRetries }) => {
      calls++; retries = maxRetries;
      return { values, warnings: [], embeddings: vectors(values), usage: { tokens: 32_768 } };
    });
    const parent = new BudgetTracker({ label: 'parent', maxCostUsd: 0.004 });
    await expect(withBudgetTracker(parent, () => withEmbeddingBudget(config('0.003'), async () => {
      await embed(['你好'], { maxRetries: 3 });
      await embed(['next']);
    }))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(1);
    expect(retries).toBe(0);
    expect(parent.totalSpent).toBeCloseTo(0.00196608, 8);
    expect(parent.getRemaining()).toBeCloseTo(0.004 - parent.totalSpent, 8);
  });

  test('unknown usage consumes the maximum, including an ambiguous failure', async () => {
    configure();
    let calls = 0;
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      calls++;
      if (calls === 1) return { values, warnings: [], embeddings: vectors(values) };
      throw new Error('connection reset after send');
    }) as never);
    const tracker = new BudgetTracker({ label: 'unknown', maxCostUsd: 0.004 });
    await withBudgetTracker(tracker, () => embed(['first']));
    await expect(withBudgetTracker(tracker, () => embed(['second']))).rejects.toThrow();
    expect(tracker.totalSpent).toBeCloseTo(0.00393216, 8);
    await expect(withBudgetTracker(tracker, () => embed(['third']))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(2);
    expect(tracker.snapshot().models[0]?.cost_basis).toBe('estimated');
  });

  test('missing provider wire usage does not become a measured zero', async () => {
    configure();
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => Response.json({
      data: [{ index: 0, embedding: Array.from({ length: dims }, () => 0.1) }], usage: {},
    }), { preconnect: () => { throw new Error('unexpected preconnect'); } }));
    try {
      const tracker = new BudgetTracker({ label: 'wire-usage', maxCostUsd: 0.003 });
      await withBudgetTracker(tracker, () => embed(['tiny']));
      expect(tracker.totalSpent).toBeCloseTo(0.00196608, 8);
      expect(tracker.snapshot().models[0]?.cost_basis).toBe('estimated');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });

  test('a guard sees the provider maximum and its refusal releases the local hold', async () => {
    configure();
    let calls = 0;
    let maximum: number | undefined;
    __setEmbedTransportForTests(async ({ values }) => { calls++; return { values, warnings: [], embeddings: vectors(values), usage: { tokens: 1 } }; });
    const tracker = new BudgetTracker({ label: 'guard', maxCostUsd: 0.003 });
    await expect(withBudgetTracker(tracker, () => withAIInvocationGuard(async call => {
      maximum = call.maxInputTokens;
      throw new Error('guard refused');
    }, () => embed(['tiny'])))).rejects.toThrow('guard refused');
    expect(maximum).toBe(32_768);
    expect(calls).toBe(0);
    expect(tracker.getRemaining()).toBe(0.003);
  });

  test('each retry after an ambiguous token-limit error is separately reserved', async () => {
    configure();
    let calls = 0;
    __setEmbedTransportForTests(async ({ values }) => {
      calls++;
      if (calls === 1) throw new Error('batch token limit exceeded');
      return { values, warnings: [], embeddings: vectors(values), usage: { tokens: 1 } };
    });
    const tracker = new BudgetTracker({ label: 'retry', maxCostUsd: 0.004 });
    await expect(withBudgetTracker(tracker, () => embed(['a', 'b']))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(1);
    expect(tracker.totalSpent).toBeCloseTo(0.00393216, 8);
  });

  test('unknown pricing and unknown provider ceilings both refuse before wire', async () => {
    configureGateway({ embedding_model: 'voyage:voyage-4-nano', embedding_dimensions: dims, env: { VOYAGE_API_KEY: 'fake' } });
    let calls = 0;
    __setEmbedTransportForTests(async () => { calls++; throw new Error('unexpected wire'); });
    await expect(withEmbeddingBudget(config('5'), () => embed(['x']))).rejects.toMatchObject({ reason: 'no_pricing' });
    resetGateway();
    configureGateway({ embedding_model: 'llama-server:custom', embedding_dimensions: dims, env: {} });
    const tracker = new BudgetTracker({ label: 'unknown-bound', maxCostUsd: 5, pricingOverrides: { 'llama-server:custom': { input: 1, output: 0 } } });
    await expect(withBudgetTracker(tracker, () => embed(['x']))).rejects.toThrow('No provider token ceiling');
    expect(calls).toBe(0);
  });

  test('SDK item splits are separately admitted so successful sibling requests are never released on failure', async () => {
    configure();
    const sizes: number[] = [];
    __setEmbedTransportForTests(async ({ values }) => {
      sizes.push(values.length);
      return { values, warnings: [], embeddings: vectors(values), usage: { tokens: 120_000 } };
    });
    const tracker = new BudgetTracker({ label: 'sdk-split', maxCostUsd: 0.008 });
    await expect(withBudgetTracker(tracker, () => embed(Array.from({ length: 2049 }, () => 'x')))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(sizes).toEqual([2048]);
    expect(tracker.totalSpent).toBeCloseTo(0.0072, 8);
  });

  test('a child denial rolls back its hold and parallel calls share the ancestor cap', () => {
    const price = { 'voyage:voyage-4': { input: 1, output: 0 } };
    const parent = new BudgetTracker({ label: 'parent', maxCostUsd: 0.8, pricingOverrides: price });
    const child = new BudgetTracker({ label: 'child', maxCostUsd: 1, pricingOverrides: price, parentTracker: parent });
    const estimate = { modelId: 'voyage:voyage-4', estimatedInputTokens: 600_000, maxOutputTokens: 0, kind: 'embed' as const };
    const first = child.reserve(estimate);
    expect(() => child.reserve(estimate)).toThrow(BudgetExhausted);
    expect(child.getRemaining()).toBeCloseTo(0.2);
    child.release(first);
    expect(child.getRemaining()).toBeCloseTo(0.8);
    const next = child.reserve(estimate);
    child.record({ modelId: estimate.modelId, kind: 'embed', reservation: next, inputTokens: 100_000 });
    expect(child.totalSpent).toBeCloseTo(0.1);
    expect(parent.totalSpent).toBeCloseTo(0.1);
  });

  test('explicit limits survive tokenmax and malformed values fail closed', async () => {
    expect(await configuredEmbeddingCapUsd(config('0.5'))).toBe(0.5);
    for (const value of [null, 'off', 'unlimited', 'none']) expect(await configuredEmbeddingCapUsd(config(value))).toBeUndefined();
    for (const value of ['0', 'garbage', '-1']) await expect(configuredEmbeddingCapUsd(config(value))).rejects.toThrow('embed.backfill_max_usd');
  });
});
