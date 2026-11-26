/**
 * #10424: the chat usage ledger prices a call with the operator's
 * `pricing.overrides`, the same resolver the budget meter uses, and reads
 * that config once per TTL window rather than once per row.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeEngineChatUsageSink, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';

function record(over: Partial<ChatUsageRecord>): ChatUsageRecord {
  return {
    model: 'acme-example:unknown-model',
    provider: 'acme-example',
    phase: null,
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: null,
    ...over,
  };
}

describe('chat usage ledger + pricing.overrides (#10424)', () => {
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
    await engine.setConfig('pricing.overrides', JSON.stringify({ 'litellm:gateway-model': { input: 0.1, output: 0.5 } }));
  });

  async function costs(): Promise<Record<string, number | null>> {
    const rows = await engine.executeRaw<{ model: string; cost_usd: string | number | null }>(
      'SELECT model, cost_usd FROM chat_usage_log ORDER BY id',
    );
    return Object.fromEntries(rows.map((row) => [row.model, row.cost_usd === null ? null : Math.round(Number(row.cost_usd) * 1e6) / 1e6]));
  }

  test('a model priced only by an override gets the override cost; an unknown model stays NULL', async () => {
    const sink = makeEngineChatUsageSink(engine);
    await sink(record({ model: 'litellm:gateway-model', provider: 'litellm' }));
    await sink(record({ model: 'acme-example:unknown-model' }));
    expect(await costs()).toEqual({ 'litellm:gateway-model': 0.6, 'acme-example:unknown-model': null });
  });

  test('a table-priced model with no override keeps the price it arrived with', async () => {
    const sink = makeEngineChatUsageSink(engine);
    await sink(record({ model: 'anthropic:claude-haiku-4-5', provider: 'anthropic', cost_usd: 0.0035 }));
    expect(await costs()).toEqual({ 'anthropic:claude-haiku-4-5': 0.0035 });
  });

  test('the sink reads pricing.overrides once for many rows', async () => {
    let reads = 0;
    const counted = {
      executeRaw: (sql: string, params?: unknown[]) => engine.executeRaw(sql, params),
      getConfig: (key: string) => { reads++; return engine.getConfig(key); },
    };
    const sink = makeEngineChatUsageSink(counted);
    for (let i = 0; i < 5; i++) await sink(record({ model: 'litellm:gateway-model', provider: 'litellm' }));
    expect(reads).toBe(1);
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chat_usage_log WHERE cost_usd IS NOT NULL');
    expect(Number(rows[0].n)).toBe(5);
  });

  test('a failed overrides read keeps the record as it arrived', async () => {
    const failing = {
      executeRaw: (sql: string, params?: unknown[]) => engine.executeRaw(sql, params),
      getConfig: async (_key: string): Promise<string | null> => { throw new Error('config unavailable'); },
    };
    const sink = makeEngineChatUsageSink(failing);
    await sink(record({ model: 'litellm:gateway-model', provider: 'litellm' }));
    expect(await costs()).toEqual({ 'litellm:gateway-model': null });
  });
});
