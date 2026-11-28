/**
 * Capped embedding runs admit each provider request at its input ceiling and
 * settle it to the provider's reported usage (#6984; reported in #10581).
 *
 * Pins, transport stubbed at the __setEmbedTransportForTests seam unless a
 * case drives the real wire shim through a stubbed fetch:
 *   - a capped tracker reserves the request's input ceiling (one token per
 *     UTF-8 byte, capped per input), not the chars-per-token estimate, so a
 *     request that cannot fit is refused before it is sent
 *   - unknown usage and an ambiguous failure keep that ceiling charged
 *   - SDK item splits become separately admitted requests under a cap, and
 *     the SDK's hidden retries are off (each attempt needs its own hold)
 *   - Voyage usage without total_tokens is unknown, never a measured zero
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, embed, withBudgetTracker, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { withAIInvocationGuard, type AIInvocationUsage } from '../src/core/ai/invocation-guard.ts';
import { BudgetExhausted, BudgetTracker } from '../src/core/budget/budget-tracker.ts';

const DIMS = 8;
const PRICE = 0.02 / 1_000_000;
const CJK = '你'.repeat(400);
const CJK_CEILING = 1200;
const realFetch = globalThis.fetch;

const configureOpenAI = () => configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-fake' } });
const vectors = (values: string[]) => values.map(() => Array.from({ length: DIMS }, () => 0.1));

afterEach(() => {
  __setEmbedTransportForTests(null);
  globalThis.fetch = realFetch;
  resetGateway();
});

describe('capped embedding admission', () => {
  test('a request whose input ceiling does not fit is refused before it is sent', async () => {
    configureOpenAI();
    let calls = 0;
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      calls++;
      return { embeddings: vectors(values), usage: { tokens: CJK_CEILING } };
    }) as never);
    const tracker = new BudgetTracker({ label: 'ceiling', maxCostUsd: 500 * PRICE });
    await expect(withBudgetTracker(tracker, () => embed([CJK]))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(0);
    expect(tracker.totalSpent).toBe(0);
  });

  test('usage the provider did not report keeps the reserved ceiling charged', async () => {
    configureOpenAI();
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: vectors(values) })) as never);
    const tracker = new BudgetTracker({ label: 'unknown-usage', maxCostUsd: 1 });
    await withBudgetTracker(tracker, () => embed([CJK]));
    expect(tracker.totalSpent).toBeCloseTo(CJK_CEILING * PRICE, 12);
    expect(tracker.snapshot().models[0]?.cost_basis).toBe('estimated');
  });

  test('a failure that may have billed keeps the reserved ceiling charged', async () => {
    configureOpenAI();
    __setEmbedTransportForTests((async () => { throw new Error('connection reset after send'); }) as never);
    const tracker = new BudgetTracker({ label: 'ambiguous-failure', maxCostUsd: 1 });
    await expect(withBudgetTracker(tracker, () => embed([CJK]))).rejects.toThrow();
    expect(tracker.totalSpent).toBeCloseTo(CJK_CEILING * PRICE, 12);
  });

  test('reported usage settles each request exactly', async () => {
    configureOpenAI();
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: vectors(values), usage: { tokens: 7 } })) as never);
    const tracker = new BudgetTracker({ label: 'measured', maxCostUsd: 1 });
    await withBudgetTracker(tracker, () => embed([CJK]));
    expect(tracker.totalSpent).toBeCloseTo(7 * PRICE, 12);
    expect(tracker.snapshot().models[0]?.cost_basis).toBe('measured');
  });

  test('SDK item splits are sent as separately admitted requests', async () => {
    configureOpenAI();
    const sizes: number[] = [];
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      sizes.push(values.length);
      return { embeddings: vectors(values), usage: { tokens: values.length } };
    }) as never);
    const tracker = new BudgetTracker({ label: 'sdk-split', maxCostUsd: 1 });
    await withBudgetTracker(tracker, () => embed(Array.from({ length: 2049 }, () => 'x')));
    expect(sizes).toEqual([2048, 1]);
    expect(tracker.totalSpent).toBeCloseTo(2049 * PRICE, 12);
  });

  test("the SDK's hidden retries are off under a cap", async () => {
    configureOpenAI();
    let retries: number | undefined;
    __setEmbedTransportForTests((async ({ values, maxRetries }: { values: string[]; maxRetries?: number }) => {
      retries = maxRetries;
      return { embeddings: vectors(values), usage: { tokens: 1 } };
    }) as never);
    await withBudgetTracker(new BudgetTracker({ label: 'retries', maxCostUsd: 1 }), () => embed(['x'], { maxRetries: 3 }));
    expect(retries).toBe(0);
  });

  test('an uncapped tracker keeps the caller retry policy', async () => {
    configureOpenAI();
    let retries: number | undefined;
    __setEmbedTransportForTests((async ({ values, maxRetries }: { values: string[]; maxRetries?: number }) => {
      retries = maxRetries;
      return { embeddings: vectors(values), usage: { tokens: 1 } };
    }) as never);
    await withBudgetTracker(new BudgetTracker({ label: 'uncapped' }), () => embed(['x'], { maxRetries: 3 }));
    expect(retries).toBe(3);
  });
});

describe('provider usage on the wire', () => {
  test('Voyage usage without total_tokens reaches a job guard as unknown, not zero', async () => {
    configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 256, env: { VOYAGE_API_KEY: 'sk-fake' } });
    globalThis.fetch = (async () => Response.json({
      object: 'list', data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 256 }, () => 0.1) }], usage: {},
    })) as unknown as typeof fetch;
    const settled: Array<AIInvocationUsage | null> = [];
    await withAIInvocationGuard(async () => ({ settle: async usage => { settled.push(usage); } }), () => embed(['tiny']));
    expect(settled).toEqual([null]);
  });
});
