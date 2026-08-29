/**
 * #4218 — chat usage accounting (revives the #3392 shape).
 *
 * Pins the full loop: gateway.chat() success boundary → recordChatUsage →
 * phase attribution (direct vs job callers) → canonical cost math incl.
 * cache tokens → engine sink INSERT into chat_usage_log (migration v140) →
 * the admin-scope get_usage op with explicit coverage fields (admin: the
 * ledger has no source dimension, so source-scoped read tokens are fenced). Failure paths:
 * a failed chat writes NO row; a throwing sink never breaks a chat call;
 * unknown-pricing models record cost_usd NULL (never a fake 0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  chat,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  withChatPhase,
  currentChatPhase,
  setChatUsageSink,
  registerChatUsageSink,
  recordChatUsage,
  estimateChatCostUsd,
  makeEngineChatUsageSink,
  type ChatUsageRecord,
} from '../src/core/ai/chat-usage.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

function fakeResult(over: Partial<ChatResult> = {}): ChatResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
    ...over,
  };
}

afterEach(() => {
  __setChatTransportForTests(null);
  setChatUsageSink(null);
});

describe('#4480 — sink registry: multi-engine deregistration restores the prior ledger', () => {
  const usage = { input_tokens: 1, output_tokens: 1 };

  test('records route to the top live sink; deregistering it restores the previous one', () => {
    const primary: ChatUsageRecord[] = [];
    const secondary: ChatUsageRecord[] = [];
    const deregPrimary = registerChatUsageSink((r) => { primary.push(r); });
    const deregSecondary = registerChatUsageSink((r) => { secondary.push(r); });

    recordChatUsage({ model: 'anthropic:claude-haiku-4-5', usage });
    expect(secondary.length).toBe(1);
    expect(primary.length).toBe(0);

    // The short-lived secondary engine disconnects. Pre-fix (last-wins
    // scalar) the ledger was permanently lost to the closed engine; now the
    // primary sink is restored.
    deregSecondary();
    recordChatUsage({ model: 'anthropic:claude-haiku-4-5', usage });
    expect(primary.length).toBe(1);
    expect(secondary.length).toBe(1);

    deregPrimary();
    // No live sink: record is a silent no-op (never throws).
    recordChatUsage({ model: 'anthropic:claude-haiku-4-5', usage });
    expect(primary.length).toBe(1);
    // Deregistration is idempotent.
    deregSecondary();
    deregPrimary();
  });

  test('out-of-order deregistration removes only its own entry', () => {
    const a: ChatUsageRecord[] = [];
    const b: ChatUsageRecord[] = [];
    const c: ChatUsageRecord[] = [];
    const deregA = registerChatUsageSink((r) => { a.push(r); });
    const deregB = registerChatUsageSink((r) => { b.push(r); });
    const deregC = registerChatUsageSink((r) => { c.push(r); });
    // Middle entry disconnects first — top stays the router.
    deregB();
    recordChatUsage({ model: 'anthropic:claude-haiku-4-5', usage });
    expect(c.length).toBe(1);
    deregC();
    recordChatUsage({ model: 'anthropic:claude-haiku-4-5', usage });
    expect(a.length).toBe(1);
    expect(b.length).toBe(0);
    deregA();
  });

  test('setChatUsageSink(null) clears every registered entry (legacy scalar API)', () => {
    const a: ChatUsageRecord[] = [];
    registerChatUsageSink((r) => { a.push(r); });
    setChatUsageSink(null);
    recordChatUsage({ model: 'anthropic:claude-haiku-4-5', usage });
    expect(a.length).toBe(0);
  });
});

describe('estimateChatCostUsd — canonical pricing incl. cache tokens', () => {
  test('anthropic model prices cache reads at 0.1x and writes at 1.25x input', () => {
    // haiku-4-5: $1/M in, $5/M out, $0.10/M cache-read, $1.25/M cache-write
    const cost = estimateChatCostUsd('anthropic:claude-haiku-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1 + 5 + 0.1 + 1.25, 8);
  });

  test('provider without cache rates falls back to the input rate for cache tokens', () => {
    // gpt-4o: $2.50/M in, $10/M out; no cache fields → cache tokens at input rate
    const cost = estimateChatCostUsd('openai:gpt-4o', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2.5 + 2.5, 8);
  });

  test('unknown model → null, never a fake 0', () => {
    expect(
      estimateChatCostUsd('acme:unpriced-model-9000', { input_tokens: 10, output_tokens: 10 }),
    ).toBeNull();
  });
});

describe('gateway.chat() success boundary — direct vs job callers', () => {
  test('direct caller records phase NULL; job caller records job:<name>', async () => {
    const records: ChatUsageRecord[] = [];
    setChatUsageSink((r) => {
      records.push(r);
    });
    __setChatTransportForTests(async () => fakeResult());

    await chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] });
    await withChatPhase('job:embed-backfill', () =>
      chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    );
    // sink is fire-and-forget — let the microtask queue drain
    await new Promise((r) => setTimeout(r, 10));

    expect(records.length).toBe(2);
    expect(records[0]!.phase).toBeNull();
    expect(records[1]!.phase).toBe('job:embed-backfill');
    expect(records[0]!.model).toBe('anthropic:claude-haiku-4-5');
    expect(records[0]!.input_tokens).toBe(1000);
    expect(records[0]!.output_tokens).toBe(500);
    // $1/M * 1000 + $5/M * 500 = 0.001 + 0.0025
    expect(records[0]!.cost_usd).toBeCloseTo(0.0035, 8);
  });

  test('cache tokens flow through (cache_creation → cache_write)', async () => {
    const records: ChatUsageRecord[] = [];
    setChatUsageSink((r) => {
      records.push(r);
    });
    __setChatTransportForTests(async () =>
      fakeResult({
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 2000, cache_creation_tokens: 3000 },
      }),
    );
    await chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise((r) => setTimeout(r, 10));

    expect(records[0]!.cache_read_tokens).toBe(2000);
    expect(records[0]!.cache_write_tokens).toBe(3000);
    expect(records[0]!.cost_usd).toBeCloseTo(
      (100 * 1 + 50 * 5 + 2000 * 0.1 + 3000 * 1.25) / 1e6,
      10,
    );
  });

  test('failed chat writes NO usage row and the error propagates', async () => {
    const records: ChatUsageRecord[] = [];
    setChatUsageSink((r) => {
      records.push(r);
    });
    __setChatTransportForTests(async () => {
      throw new Error('provider exploded');
    });
    await expect(
      chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('provider exploded');
    await new Promise((r) => setTimeout(r, 10));
    expect(records.length).toBe(0);
  });

  test('a throwing sink never breaks a chat call (fail-open)', async () => {
    setChatUsageSink(() => {
      throw new Error('sink down');
    });
    __setChatTransportForTests(async () => fakeResult());
    const res = await chat({
      model: 'anthropic:claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.text).toBe('ok');
  });

  test('withChatPhase restores the outer phase after the callback', async () => {
    expect(currentChatPhase()).toBeNull();
    await withChatPhase('job:outer', async () => {
      expect(currentChatPhase()).toBe('job:outer');
    });
    expect(currentChatPhase()).toBeNull();
  });
});

describe('engine sink + get_usage op (PGLite, migration v140 schema)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM chat_usage_log');
  });

  function ctx(over: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: {} as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
      dryRun: false,
      remote: true,
      sourceId: 'default',
      ...over,
    } as OperationContext;
  }

  test('sink inserts; get_usage aggregates with explicit coverage fields', async () => {
    const sink = makeEngineChatUsageSink(engine);
    await sink({
      model: 'anthropic:claude-haiku-4-5',
      provider: 'anthropic',
      phase: null,
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 200,
      cache_write_tokens: 300,
      cost_usd: 0.0035,
    });
    await sink({
      model: 'anthropic:claude-haiku-4-5',
      provider: 'anthropic',
      phase: 'job:embed-backfill',
      input_tokens: 2000,
      output_tokens: 1000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.007,
    });
    // Unknown-pricing model: tokens counted, dollars NULL.
    await sink({
      model: 'acme:unpriced-model-9000',
      provider: 'acme',
      phase: 'job:dream',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: null,
    });

    const get_usage = operationsByName['get_usage']!;
    expect(get_usage.scope).toBe('admin');
    const out = (await get_usage.handler(ctx(), { days: 7 })) as any;

    expect(out.window_days).toBe(7);
    expect(out.totals.calls).toBe(3);
    expect(out.totals.input_tokens).toBe(3010);
    expect(out.totals.output_tokens).toBe(1520);
    expect(out.totals.cache_read_tokens).toBe(200);
    expect(out.totals.cache_write_tokens).toBe(300);
    expect(out.totals.cost_usd).toBeCloseTo(0.0105, 8);

    const haiku = out.by_model.find((m: any) => m.model === 'anthropic:claude-haiku-4-5');
    expect(haiku.calls).toBe(2);
    expect(haiku.cost_usd).toBeCloseTo(0.0105, 8);
    expect(haiku.unpriced_calls).toBe(0);
    const unpriced = out.by_model.find((m: any) => m.model === 'acme:unpriced-model-9000');
    expect(unpriced.calls).toBe(1);
    expect(unpriced.cost_usd).toBeNull();
    expect(unpriced.unpriced_calls).toBe(1);

    const direct = out.by_phase.find((p: any) => p.phase === 'direct');
    expect(direct.calls).toBe(1);
    const jobPhase = out.by_phase.find((p: any) => p.phase === 'job:embed-backfill');
    expect(jobPhase.calls).toBe(1);

    // Coverage honesty contract.
    expect(out.coverage.source).toBe('gateway.chat');
    expect(out.coverage.table_present).toBe(true);
    expect(out.coverage.logged_since).not.toBeNull();
    expect(out.coverage.priced_calls).toBe(2);
    expect(out.coverage.unpriced_calls).toBe(1);
    expect(Array.isArray(out.coverage.not_covered)).toBe(true);
    expect(out.coverage.not_covered.length).toBeGreaterThan(0);
  });

  test('end-to-end: gateway transport call lands a row via the engine sink', async () => {
    setChatUsageSink(makeEngineChatUsageSink(engine));
    __setChatTransportForTests(async () => fakeResult());
    await withChatPhase('job:signal-detector', () =>
      chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    );
    // The sink INSERT is fire-and-forget; poll briefly for the row.
    let rows: Array<{ phase: string | null; cost_usd: number | null }> = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await engine.executeRaw(
        'SELECT phase, cost_usd FROM chat_usage_log',
        [],
      );
    }
    expect(rows.length).toBe(1);
    expect(rows[0]!.phase).toBe('job:signal-detector');
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.0035, 8);
  });

  test('empty window → zeroed totals, coverage still explicit', async () => {
    const get_usage = operationsByName['get_usage']!;
    const out = (await get_usage.handler(ctx(), {})) as any;
    expect(out.window_days).toBe(30);
    expect(out.totals.calls).toBe(0);
    expect(out.by_model).toEqual([]);
    expect(out.coverage.table_present).toBe(true);
  });
});
