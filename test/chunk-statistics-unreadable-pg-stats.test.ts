import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { refreshChunkStatistics } from '../src/core/search/projection-statistics.ts';

describe('refreshChunkStatistics when pg_stats is unreadable', () => {
  beforeAll(() => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  });
  afterAll(() => resetGateway());

  test('runs the bounded ANALYZE instead of skipping it', async () => {
    const analyzed: string[] = [];
    const denied = Object.assign(new Error('permission denied for table pg_statistic'), { code: '42501' });
    const engine: BrainEngine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (/pg_stats/.test(sql)) throw denied;
        if (/^\s*ANALYZE/i.test(sql)) analyzed.push(sql);
        return [];
      },
      transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(engine),
    } as unknown as BrainEngine;
    const warn = console.warn;
    console.warn = () => {};
    let result: boolean | string;
    try { result = await refreshChunkStatistics(engine, 10); } catch (e) { result = String(e); } finally { console.warn = warn; }
    expect(analyzed.length).toBeGreaterThan(0);
    expect(result).toBe(true);
  });
});
