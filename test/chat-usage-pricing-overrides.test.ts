/**
 * #10424: the chat usage ledger prices a call with the operator's
 * `pricing.overrides`, the same resolver the budget meter uses, and reads
 * that config once per TTL window rather than once per row.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngineChatUsageSink, recordChatUsage, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';
import { createEngine } from '../src/core/engine-factory.ts';

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

  test('a failed overrides read is not cached: the next row reads again and is priced', async () => {
    let reads = 0;
    const flaky = {
      executeRaw: (sql: string, params?: unknown[]) => engine.executeRaw(sql, params),
      getConfig: async (key: string): Promise<string | null> => { if (reads++ === 0) throw new Error('config unavailable'); return engine.getConfig(key); },
    };
    const sink = makeEngineChatUsageSink(flaky);
    await sink(record({ model: 'litellm:gateway-model', provider: 'litellm' }));
    await sink(record({ model: 'litellm:gateway-model', provider: 'acme-example' }));
    const rows = await engine.executeRaw<{ cost_usd: string | number | null }>('SELECT cost_usd FROM chat_usage_log ORDER BY id');
    expect(rows.map((row) => row.cost_usd === null ? null : Math.round(Number(row.cost_usd) * 1e6) / 1e6)).toEqual([null, 0.6]);
    expect(reads).toBe(2);
  });

  test('closing the engine right after a recorded call keeps its ledger row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-usage-close-'));
    try {
      const config = { engine: 'pglite' as const, database_path: join(dir, 'brain') };
      const writer = await createEngine(config);
      await writer.connect(config);
      await writer.initSchema();
      await writer.setConfig('pricing.overrides', JSON.stringify({ 'litellm:gateway-model': { input: 0.1, output: 0.5 } }));
      recordChatUsage({ model: 'litellm:gateway-model', provider: 'litellm', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
      await writer.disconnect();
      const reader = await createEngine(config);
      await reader.connect(config);
      try {
        const rows = await reader.executeRaw<{ cost_usd: string | number | null }>('SELECT cost_usd FROM chat_usage_log');
        expect(rows.map((row) => Math.round(Number(row.cost_usd) * 1e6) / 1e6)).toEqual([0.6]);
      } finally { await reader.disconnect(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
