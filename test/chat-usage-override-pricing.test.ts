import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeEngineChatUsageSink } from '../src/core/ai/chat-usage.ts';

describe('chat usage ledger prices with pricing.overrides', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('a model priced only by an override gets a cost; an unknown one stays NULL', async () => {
    await engine.setConfig('pricing.overrides', JSON.stringify({ 'litellm:gpt-6-luna': { input: 0.1, output: 0.5 } }));
    const sink = makeEngineChatUsageSink(engine);
    const base = { provider: 'litellm', phase: null, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null };
    await sink({ ...base, model: 'litellm:gpt-6-luna', input_tokens: 1_000_000, output_tokens: 1_000_000 });
    await sink({ ...base, model: 'acme:unknown-xyz', input_tokens: 10, output_tokens: 10 });
    const rows = await engine.executeRaw<{ model: string; cost_usd: number | null }>(
      'SELECT model, cost_usd FROM chat_usage_log ORDER BY model',
    );
    const byModel = Object.fromEntries(rows.map((x) => [x.model, x.cost_usd === null ? null : Number(x.cost_usd)]));
    const luna = byModel['litellm:gpt-6-luna'];
    expect(luna === null || luna === undefined ? luna : Math.round(luna * 1e6) / 1e6).toBe(0.6);
    expect(byModel['acme:unknown-xyz']).toBeNull();
  });
});
