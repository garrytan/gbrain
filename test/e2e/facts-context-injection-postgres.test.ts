/**
 * v0.31 E2E — MCP _meta.brain_hot_memory injection on real Postgres,
 * via dispatchToolCall (the same path stdio + HTTP transports use).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import {
  getBrainHotMemoryMeta,
  __resetHotMemoryCacheForTests,
} from '../../src/core/facts/meta-hook.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  await engine.insertFact(
    { fact: 'world fact', kind: 'fact', entity_slug: 'meta-pg', visibility: 'world', source: 'test' },
    { source_id: 'default' },
  );
  await engine.insertFact(
    { fact: 'private fact', kind: 'fact', entity_slug: 'meta-pg', visibility: 'private', source: 'test' },
    { source_id: 'default' },
  );
});

afterAll(async () => { if (RUN) await teardownDB(); });

beforeEach(() => { if (RUN) __resetHotMemoryCacheForTests(); });

d('_meta injection on Postgres', () => {
  test('successful op gets _meta.brain_hot_memory', async () => {
    const r = await dispatchToolCall(getEngine(), 'get_stats', {}, {
      remote: false, sourceId: 'default', metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.brain_hot_memory).toBeDefined();
  });

  test('remote=true filters to world facts only', async () => {
    const r = await dispatchToolCall(getEngine(), 'get_stats', {}, {
      remote: true, sourceId: 'default', metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    const bhm = r._meta?.brain_hot_memory as { facts: { fact: string }[] } | undefined;
    expect(bhm?.facts.find(f => f.fact === 'private fact')).toBeUndefined();
    expect(bhm?.facts.find(f => f.fact === 'world fact')).toBeDefined();
  });

  test('failing meta hook degrades to no-_meta, op still succeeds', async () => {
    const failHook = async (): Promise<Record<string, unknown> | undefined> => {
      throw new Error('boom');
    };
    const r = await dispatchToolCall(getEngine(), 'get_stats', {}, {
      remote: true, sourceId: 'default', metaHook: failHook,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta).toBeUndefined();
  });

  test('recall op itself does NOT get _meta injection (anti-loop)', async () => {
    const r = await dispatchToolCall(getEngine(), 'recall', { entity: 'meta-pg' }, {
      remote: false, sourceId: 'default', metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.brain_hot_memory).toBeUndefined();
  });
});
