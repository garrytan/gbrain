/**
 * D2 remediation for the #2119 read-side merge (src/core/config-db-merge.ts).
 *
 * The merge used to issue ~12 sequential engine.getConfig SELECTs per
 * loadConfigWithEngine call — and that loader runs twice per uncached search,
 * so a remote Postgres brain paid up to ~2s of pure config-read latency per
 * query. It now fetches every merged key in ONE batched statement
 * (`key = ANY($1) OR key LIKE 'cycle.%'`) and memoizes the fetched map per
 * engine handle for ~30s (mirroring write-through.ts's sync.write_through
 * flag memo; fail-open — a read error yields no merge, never a throw).
 *
 * Pinned here:
 *   - query-count spy: one batched executeRaw, ZERO per-key getConfig calls
 *   - full merge correctness through the batched path (provider keys, chat
 *     pins, chat_fallback_chain, cycle.*)
 *   - memo: same engine handle within the TTL issues no new query; the TTL
 *     expiry re-queries (injected clock); distinct handles don't share
 *   - fail-open: a throwing executeRaw no-ops the merge without throwing
 *   - per-key fallback for engines without executeRaw (the thin-reader shape
 *     test/loadConfig-merge.test.ts fakes use)
 *   - the batched SQL is valid on a real engine (PGLite)
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import {
  applyDbPlaneReadSideMerge,
  DB_MERGE_MEMO_TTL_MS,
  _resetDbPlaneMergeMemoForTests,
  type DbPlaneEngineReader,
} from '../src/core/config-db-merge.ts';
import type { GBrainConfig } from '../src/core/config.ts';

interface Counts {
  executeRaw: number;
  getConfig: number;
  listConfigKeys: number;
}

function makeBatchEngine(map: Record<string, string>): {
  engine: DbPlaneEngineReader;
  counts: Counts;
  sqls: string[];
} {
  const counts: Counts = { executeRaw: 0, getConfig: 0, listConfigKeys: 0 };
  const sqls: string[] = [];
  const engine: DbPlaneEngineReader = {
    async getConfig(key: string) {
      counts.getConfig += 1;
      return map[key];
    },
    async listConfigKeys(prefix: string) {
      counts.listConfigKeys += 1;
      return Object.keys(map).filter((k) => k.startsWith(prefix));
    },
    async executeRaw<T>(sql: string, params?: unknown[]) {
      counts.executeRaw += 1;
      sqls.push(sql);
      const keys = (params?.[0] ?? []) as string[];
      return Object.entries(map)
        .filter(([k]) => keys.includes(k) || k.startsWith('cycle.'))
        .map(([key, value]) => ({ key, value })) as T[];
    },
  };
  return { engine, counts, sqls };
}

function makeFallbackEngine(map: Record<string, string>): {
  engine: DbPlaneEngineReader;
  counts: Counts;
} {
  const counts: Counts = { executeRaw: 0, getConfig: 0, listConfigKeys: 0 };
  const engine: DbPlaneEngineReader = {
    async getConfig(key: string) {
      counts.getConfig += 1;
      return map[key];
    },
    async listConfigKeys(prefix: string) {
      counts.listConfigKeys += 1;
      return Object.keys(map).filter((k) => k.startsWith(prefix));
    },
    // no executeRaw — thin config-reader shape
  };
  return { engine, counts };
}

afterEach(() => {
  _resetDbPlaneMergeMemoForTests();
});

describe('applyDbPlaneReadSideMerge — batched read (D2)', () => {
  test('one batched executeRaw; zero per-key getConfig / listConfigKeys', async () => {
    const { engine, counts, sqls } = makeBatchEngine({
      openai_api_key: 'sk-db-example',
      chat_model: 'anthropic:claude-haiku-4-5',
      'cycle.auto_think.enabled': 'true',
    });
    const merged: GBrainConfig = { engine: 'pglite' };
    await applyDbPlaneReadSideMerge(merged, engine);

    expect(counts.executeRaw).toBe(1);
    expect(counts.getConfig).toBe(0);
    expect(counts.listConfigKeys).toBe(0);
    // The single statement carries BOTH arms: scalar batch + cycle prefix.
    expect(sqls[0]).toContain('key = ANY($1)');
    expect(sqls[0]).toContain(`key LIKE 'cycle.%'`);
  });

  test('merges provider keys, chat pins, chat_fallback_chain, and cycle.* from the batch', async () => {
    const { engine } = makeBatchEngine({
      openai_api_key: 'sk-db-example',
      voyage_api_key: 'vg-db-example',
      expansion_model: 'openai:gpt-5-mini',
      chat_model: 'anthropic:claude-haiku-4-5',
      chat_fallback_chain: 'anthropic:claude-haiku-4-5, openai:gpt-5-mini',
      'cycle.auto_think.enabled': 'true',
      'cycle.extract_atoms.budget_usd': '0.25',
    });
    const merged: GBrainConfig = { engine: 'pglite' };
    await applyDbPlaneReadSideMerge(merged, engine);

    expect(merged.openai_api_key).toBe('sk-db-example');
    expect(merged.voyage_api_key).toBe('vg-db-example');
    expect(merged.expansion_model).toBe('openai:gpt-5-mini');
    expect(merged.chat_model).toBe('anthropic:claude-haiku-4-5');
    expect(merged.chat_fallback_chain).toEqual([
      'anthropic:claude-haiku-4-5',
      'openai:gpt-5-mini',
    ]);
    expect(merged.cycle).toEqual({
      'auto_think.enabled': 'true',
      'extract_atoms.budget_usd': '0.25',
    });
  });

  test('file/env precedence survives the batch: defined fields are never overwritten', async () => {
    const { engine } = makeBatchEngine({
      openai_api_key: 'sk-db-loser',
      chat_model: 'db-loser-model',
      'cycle.auto_think.enabled': 'false',
    });
    const merged: GBrainConfig = {
      engine: 'pglite',
      openai_api_key: 'sk-file-winner',
      chat_model: 'file-winner-model',
      cycle: { 'auto_think.enabled': 'true' },
    };
    await applyDbPlaneReadSideMerge(merged, engine);

    expect(merged.openai_api_key).toBe('sk-file-winner');
    expect(merged.chat_model).toBe('file-winner-model');
    expect(merged.cycle?.['auto_think.enabled']).toBe('true');
  });
});

describe('applyDbPlaneReadSideMerge — ~30s memo per engine handle (D2)', () => {
  test('second merge on the same engine within the TTL issues no new query', async () => {
    const { engine, counts } = makeBatchEngine({ chat_model: 'anthropic:claude-haiku-4-5' });
    await applyDbPlaneReadSideMerge({ engine: 'pglite' }, engine);
    expect(counts.executeRaw).toBe(1);

    const second: GBrainConfig = { engine: 'pglite' };
    await applyDbPlaneReadSideMerge(second, engine);
    expect(counts.executeRaw).toBe(1); // memo hit — no second round trip
    expect(second.chat_model).toBe('anthropic:claude-haiku-4-5'); // values still merge
  });

  test('TTL expiry re-queries (injected clock)', async () => {
    let now = 0;
    _resetDbPlaneMergeMemoForTests(() => now);
    const { engine, counts } = makeBatchEngine({ chat_model: 'anthropic:claude-haiku-4-5' });

    await applyDbPlaneReadSideMerge({ engine: 'pglite' }, engine);
    expect(counts.executeRaw).toBe(1);

    now = DB_MERGE_MEMO_TTL_MS - 1; // still inside the window
    await applyDbPlaneReadSideMerge({ engine: 'pglite' }, engine);
    expect(counts.executeRaw).toBe(1);

    now = DB_MERGE_MEMO_TTL_MS; // window elapsed — must re-read
    await applyDbPlaneReadSideMerge({ engine: 'pglite' }, engine);
    expect(counts.executeRaw).toBe(2);
  });

  test('distinct engine handles do not share the memo', async () => {
    const a = makeBatchEngine({ chat_model: 'model-a' });
    const b = makeBatchEngine({ chat_model: 'model-b' });
    const mergedA: GBrainConfig = { engine: 'pglite' };
    const mergedB: GBrainConfig = { engine: 'pglite' };
    await applyDbPlaneReadSideMerge(mergedA, a.engine);
    await applyDbPlaneReadSideMerge(mergedB, b.engine);
    expect(mergedA.chat_model).toBe('model-a');
    expect(mergedB.chat_model).toBe('model-b');
    expect(a.counts.executeRaw).toBe(1);
    expect(b.counts.executeRaw).toBe(1);
  });
});

describe('applyDbPlaneReadSideMerge — fail-open', () => {
  test('a throwing executeRaw no-ops the merge without throwing (and memoizes the miss)', async () => {
    let throws = 0;
    const engine: DbPlaneEngineReader = {
      async getConfig() {
        throw new Error('unreachable — batched path must not fall back per key');
      },
      async executeRaw<T>(): Promise<T[]> {
        throws += 1;
        throw new Error('relation "config" does not exist');
      },
    };
    const merged: GBrainConfig = { engine: 'pglite' };
    await applyDbPlaneReadSideMerge(merged, engine); // must not throw
    expect(merged.chat_model).toBeUndefined();
    expect(merged.cycle).toBeUndefined();

    // The miss is memoized like any other read (write-through.ts posture):
    // a mid-migration brain doesn't hammer a missing table per config load.
    await applyDbPlaneReadSideMerge({ engine: 'pglite' }, engine);
    expect(throws).toBe(1);
  });
});

describe('applyDbPlaneReadSideMerge — per-key fallback (no executeRaw)', () => {
  test('merges via getConfig + listConfigKeys and memoizes the result', async () => {
    const { engine, counts } = makeFallbackEngine({
      anthropic_api_key: 'sk-ant-db-example',
      chat_fallback_chain: '["anthropic:claude-haiku-4-5"]',
      'cycle.enrich_thin.enabled': 'true',
    });
    const merged: GBrainConfig = { engine: 'pglite' };
    await applyDbPlaneReadSideMerge(merged, engine);

    expect(merged.anthropic_api_key).toBe('sk-ant-db-example');
    expect(merged.chat_fallback_chain).toEqual(['anthropic:claude-haiku-4-5']);
    expect(merged.cycle?.['enrich_thin.enabled']).toBe('true');
    expect(counts.executeRaw).toBe(0);
    expect(counts.getConfig).toBeGreaterThan(0);
    expect(counts.listConfigKeys).toBe(1);

    // Second merge on the same handle: fully memoized, zero new reads.
    const before = counts.getConfig;
    await applyDbPlaneReadSideMerge({ engine: 'pglite' }, engine);
    expect(counts.getConfig).toBe(before);
    expect(counts.listConfigKeys).toBe(1);
  });
});

describe('batched SQL shape on a real engine (PGLite)', () => {
  let engine: import('../src/core/pglite-engine.ts').PGLiteEngine;

  beforeAll(async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test(`key = ANY($1) OR key LIKE 'cycle.%' round-trips through PGLite`, async () => {
    await engine.setConfig('chat_model', 'anthropic:claude-haiku-4-5');
    await engine.setConfig('cycle.auto_think.enabled', 'true');
    await engine.setConfig('cycle.empty_value', ''); // dbStr semantics: unset

    const merged: GBrainConfig = { engine: 'pglite' };
    await applyDbPlaneReadSideMerge(merged, engine);

    expect(merged.chat_model).toBe('anthropic:claude-haiku-4-5');
    expect(merged.cycle).toEqual({ 'auto_think.enabled': 'true' });
  }, 60_000);
});
