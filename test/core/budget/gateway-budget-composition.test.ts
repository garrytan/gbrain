/**
 * v0.37.x — TX5: gateway-layer enforcement via AsyncLocalStorage.
 *
 * Pins the public contract:
 *   - withBudgetTracker(tracker, fn) sets up an AsyncLocalStorage scope.
 *     Every gateway.chat / embed / rerank call inside the scope auto-
 *     composes the tracker without explicit per-call injection.
 *   - Nested scopes replace the active tracker for the inner closure and
 *     restore the outer tracker on exit.
 *   - Calls OUTSIDE any withBudgetTracker scope are budget-no-op (the
 *     existing pre-v0.37 contract is preserved).
 *
 * Hermetic: routes through __setChatTransportForTests so no network /
 * provider / env variable is touched.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chat,
  configureGateway,
  resetGateway,
  withBudgetTracker,
  getCurrentBudgetTracker,
  __setChatTransportForTests,
  __setGenerateTextTransportForTests,
  type ChatOpts,
  type ChatResult,
} from '../../../src/core/ai/gateway.ts';
import { withAIInvocationGuard } from '../../../src/core/ai/invocation-guard.ts';
import { freePort } from '../../helpers/serve-http.ts';
import {
  BudgetTracker,
  BudgetExhausted,
  _resetBudgetTrackerWarningsForTest,
} from '../../../src/core/budget/budget-tracker.ts';

let tmp: string;
let auditPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-gw-budget-'));
  auditPath = join(tmp, 'budget.jsonl');
  _resetBudgetTrackerWarningsForTest();
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

describe('structured chat fallback budget', () => {
  const model = 'ollama:synthetic-schema-budget';
  const request: ChatOpts = {
    model,
    messages: [{ role: 'user', content: 'Return a synthetic result.' }],
    maxTokens: 128,
    responseSchema: { name: 'items', schema: { type: 'object', properties: { items: { type: 'array' } } } },
  };

  function refuseSchema(usage?: { inputTokens: number; outputTokens: number }, wrapped = false) {
    const calls: boolean[] = [];
    configureGateway({ chat_model: model, env: {} });
    __setGenerateTextTransportForTests(async args => {
      calls.push(args.output !== undefined);
      if (args.output) {
        const error = Object.assign(new Error('response_format json_schema unsupported'), { statusCode: 400, usage });
        throw wrapped ? new Error('provider wrapper', { cause: error }) : error;
      }
      return {
        content: [{ type: 'text', text: '{"items":[]}' }],
        finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 20 },
      } as never;
    });
    return calls;
  }

  const trackerFor = (maxCostUsd: number) => new BudgetTracker({
    maxCostUsd, label: 'schema-fallback', auditPath, providerRetries: 0,
    pricingOverrides: { [model]: { input: 1000, output: 1000 } },
  });

  test('records billable rejection before checking the fallback against the cap', async () => {
    const calls = refuseSchema({ inputTokens: 100, outputTokens: 100 });
    const tracker = trackerFor(0.23);
    await expect(withBudgetTracker(tracker, () => chat(request))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toEqual([true]);
    expect(tracker.totalSpent).toBeCloseTo(0.20);
    await expect(withBudgetTracker(tracker, () => chat(request))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toEqual([true]);
  });

  test('settles both attempts when the fallback fits the cap', async () => {
    const calls = refuseSchema({ inputTokens: 100, outputTokens: 100 });
    const tracker = trackerFor(0.50);
    const result = await withBudgetTracker(tracker, () => chat(request));
    expect(result.text).toBe('{"items":[]}');
    expect(calls).toEqual([true, false]);
    expect(tracker.totalSpent).toBeCloseTo(0.24);
    expect(tracker.snapshot().models).toMatchObject([{ calls: 1, attempts: 2, failed_calls: 0 }]);
  });

  test('counts a failing schemaless retry as one failed gateway call', async () => {
    configureGateway({ chat_model: model, env: {} });
    __setGenerateTextTransportForTests(async args => {
      if (args.output) throw Object.assign(new Error('response_format json_schema unsupported'), { statusCode: 400 });
      throw Object.assign(new Error('temporary service failure'), { statusCode: 503 });
    });
    const tracker = trackerFor(0.50);
    await expect(withBudgetTracker(tracker, () => chat(request))).rejects.toThrow('temporary service failure');
    expect(tracker.snapshot().models).toMatchObject([{ calls: 1, attempts: 2, failed_calls: 1 }]);
  });

  test.each([false, true])('an unbilled schema rejection leaves budget for fallback (wrapped=%s)', async wrapped => {
    const calls = refuseSchema(undefined, wrapped);
    const tracker = trackerFor(0.18);
    await withBudgetTracker(tracker, () => chat(request));
    expect(calls).toEqual([true, false]);
    expect(tracker.totalSpent).toBeCloseTo(0.04);
    expect(tracker.snapshot().models).toMatchObject([{ calls: 1, attempts: 2, failed_calls: 0, cost_basis: 'measured' }]);
  });

  test('a rejected request cannot credit malformed negative usage to the tracker', async () => {
    const calls = refuseSchema({ inputTokens: -100, outputTokens: 100 });
    const tracker = trackerFor(0.23);
    await expect(withBudgetTracker(tracker, () => chat(request))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toEqual([true]);
    expect(tracker.totalSpent).toBeGreaterThanOrEqual(0.10);
  });

  test('fills missing error usage fields from the HTTP body', async () => {
    configureGateway({ chat_model: model, env: {} });
    let calls = 0;
    __setGenerateTextTransportForTests(async () => {
      calls++;
      throw Object.assign(new Error('response_format json_schema unsupported'), {
        statusCode: 400,
        usage: { outputTokens: 0 },
        responseBody: '{"usage":{"prompt_tokens":200,"completion_tokens":0}}',
      });
    });
    const tracker = trackerFor(0.23);
    await expect(withBudgetTracker(tracker, () => chat(request))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(1);
    expect(tracker.totalSpent).toBeCloseTo(0.20);
  });

  test.each([false, true])('checks the budget after a real SDK HTTP error body (oversized=%s)', async oversized => {
    const port = await freePort();
    const calls: boolean[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(httpRequest) {
      const payload = await httpRequest.json() as { response_format?: unknown };
      calls.push(payload.response_format !== undefined);
      return Response.json({
        error: { message: 'response_format json_schema unsupported' },
        usage: { prompt_tokens: 80, completion_tokens: 80, total_tokens: 160 },
        ...(oversized ? { debug: 'x'.repeat(64 * 1024) } : {}),
      }, { status: 400 });
    } });
    try {
      configureGateway({ chat_model: model, env: {}, base_urls: { ollama: `http://127.0.0.1:${port}/v1` } });
      const tracker = trackerFor(0.23);
      await expect(withBudgetTracker(tracker, () => chat(request))).rejects.toBeInstanceOf(BudgetExhausted);
      expect(calls).toEqual([true]);
      if (oversized) expect(tracker.totalSpent).toBeGreaterThan(0.12);
      else expect(tracker.totalSpent).toBeCloseTo(0.16);
    } finally {
      await server.stop(true);
    }
  });

  test('releases the retry reservation when the invocation guard refuses it', async () => {
    const calls = refuseSchema();
    const tracker = trackerFor(0.18);
    const refusal = new Error('synthetic invocation refusal');
    await expect(withBudgetTracker(tracker, () => withAIInvocationGuard(async () => {
      if (calls.length > 0) throw refusal;
      return { settle: async () => {} };
    }, () => chat(request)))).rejects.toBe(refusal);
    expect(calls).toEqual([true]);
    expect(tracker.totalSpent).toBe(0);
    await withBudgetTracker(tracker, () => chat(request));
    expect(calls).toEqual([true, false]);
    expect(tracker.totalSpent).toBeCloseTo(0.04);
  });
});

function fakeChatTransport(usage = { input_tokens: 100, output_tokens: 50 }) {
  let calls = 0;
  const fn = async (_opts: ChatOpts): Promise<ChatResult> => {
    calls++;
    return {
      text: 'ok',
      blocks: [{ type: 'text', text: 'ok' }],
      stopReason: 'end',
      model: 'claude-haiku-4-5-20251001',
      providerId: 'anthropic',
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
    };
  };
  return Object.assign(fn, { get calls() { return calls; } });
}

describe('withBudgetTracker — scope semantics', () => {
  test('chat() inside scope auto-composes the tracker', async () => {
    const tracker = new BudgetTracker({ maxCostUsd: 1.0, label: 'test-gw', auditPath });
    const transport = fakeChatTransport({ input_tokens: 1000, output_tokens: 500 });
    __setChatTransportForTests(transport);

    expect(getCurrentBudgetTracker()).toBeNull();

    await withBudgetTracker(tracker, async () => {
      expect(getCurrentBudgetTracker()).toBe(tracker);
      await chat({
        model: 'claude-haiku-4-5-20251001',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });

    expect(getCurrentBudgetTracker()).toBeNull();
    // Haiku: 1K in + 500 out → ($1/M × 1K) + ($5/M × 500) = $0.001 + $0.0025 = $0.0035
    expect(tracker.totalSpent).toBeCloseTo(0.0035, 6);
    expect(tracker.snapshot().callsRecorded).toBe(1);
  });

  test('chat() OUTSIDE any scope is a budget no-op (back-compat)', async () => {
    const transport = fakeChatTransport();
    __setChatTransportForTests(transport);
    // No withBudgetTracker wrapper — current behavior preserved.
    await chat({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // No tracker; nothing to assert other than "no throw".
    expect(getCurrentBudgetTracker()).toBeNull();
  });

  test('nested scopes restore outer tracker on exit', async () => {
    const outer = new BudgetTracker({ maxCostUsd: 1.0, label: 'outer', auditPath });
    const inner = new BudgetTracker({ maxCostUsd: 1.0, label: 'inner', auditPath: join(tmp, 'inner.jsonl') });

    await withBudgetTracker(outer, async () => {
      expect(getCurrentBudgetTracker()).toBe(outer);
      await withBudgetTracker(inner, async () => {
        expect(getCurrentBudgetTracker()).toBe(inner);
      });
      expect(getCurrentBudgetTracker()).toBe(outer);
    });
    expect(getCurrentBudgetTracker()).toBeNull();
  });

  test('over-cap chat call throws BudgetExhausted via reserve()', async () => {
    const tracker = new BudgetTracker({ maxCostUsd: 0.001, label: 'tight', auditPath });
    const transport = fakeChatTransport();
    __setChatTransportForTests(transport);

    let caught: unknown = null;
    await withBudgetTracker(tracker, async () => {
      try {
        await chat({
          // Opus 4.7 with high maxTokens → projected cost > $0.001
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'a'.repeat(40_000) }],
          maxTokens: 4096,
        });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect((caught as BudgetExhausted).reason).toBe('cost');
    // The transport should NOT have been called — reserve() fired first.
    expect(transport.calls).toBe(0);
  });

  test('TX1 mid-run: cumulative > cap throws via record() after the call', async () => {
    // Reserve passes (small input estimate); record() over-shoots cap.
    const tracker = new BudgetTracker({ maxCostUsd: 0.005, label: 'tx1', auditPath });
    // Mock transport reports huge actual usage
    const transport = fakeChatTransport({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    __setChatTransportForTests(transport);

    // First call: reserve fits (small chars), record() over-shoots and TX1
    // suppresses internally. Second call: reserve sees cumulative > cap.
    await withBudgetTracker(tracker, async () => {
      // First call — record() throws internally but is suppressed.
      await chat({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'short' }],
        maxTokens: 100,
      });
      expect(tracker.totalSpent).toBeGreaterThan(0.005);

      // Second call: reserve() sees cumulative > cap and throws.
      let caught: unknown = null;
      try {
        await chat({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'short' }],
          maxTokens: 100,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BudgetExhausted);
      expect((caught as BudgetExhausted).reason).toBe('cost');
    });
  });
});

describe('AsyncLocalStorage isolation', () => {
  test('parallel withBudgetTracker scopes do not bleed trackers', async () => {
    const t1 = new BudgetTracker({ maxCostUsd: 1.0, label: 'parallel-1', auditPath });
    const t2 = new BudgetTracker({ maxCostUsd: 1.0, label: 'parallel-2', auditPath: join(tmp, 'p2.jsonl') });
    const transport = fakeChatTransport({ input_tokens: 1000, output_tokens: 500 });
    __setChatTransportForTests(transport);

    await Promise.all([
      withBudgetTracker(t1, async () => {
        await chat({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'a' }] });
      }),
      withBudgetTracker(t2, async () => {
        await chat({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'b' }] });
      }),
    ]);

    // Each tracker should have exactly 1 recorded call.
    expect(t1.snapshot().callsRecorded).toBe(1);
    expect(t2.snapshot().callsRecorded).toBe(1);
  });
});
