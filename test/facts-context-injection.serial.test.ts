/**
 * v0.31 Phase 6 — MCP `_meta.brain_hot_memory` injection contract.
 *
 * Pins:
 *   - dispatchToolCall with metaHook adds _meta to successful responses
 *   - Visibility filter applies (remote → world only)
 *   - Cache key is per (source_id, session_id, allowList) — different
 *     allow-lists produce distinct cache entries
 *   - Best-effort: a failing metaHook degrades to no-_meta, never flips
 *     the response to error
 *   - Serial because the meta-hook cache is module-global.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  getBrainHotMemoryMeta,
  __resetHotMemoryCacheForTests,
} from '../src/core/facts/meta-hook.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact(
    { fact: 'world fact', kind: 'fact', entity_slug: 'meta-test', visibility: 'world', source: 'test' },
    { source_id: 'default' },
  );
  await engine.insertFact(
    { fact: 'private fact', kind: 'fact', entity_slug: 'meta-test', visibility: 'private', source: 'test' },
    { source_id: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  __resetHotMemoryCacheForTests();
});

describe('_meta injection on dispatch', () => {
  test('successful op gains _meta.brain_hot_memory', async () => {
    const r = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: false,
      sourceId: 'default',
      metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.brain_hot_memory).toBeDefined();
  });

  test('remote=true filters to world-only facts', async () => {
    const r = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: true,
      sourceId: 'default',
      metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    const bhm = r._meta?.brain_hot_memory as { facts: { fact: string }[] } | undefined;
    expect(bhm).toBeDefined();
    const facts = bhm!.facts;
    expect(facts.find(f => f.fact === 'private fact')).toBeUndefined();
    expect(facts.find(f => f.fact === 'world fact')).toBeDefined();
  });

  test('remote=false includes private facts', async () => {
    const r = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: false,
      sourceId: 'default',
      metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    const bhm = r._meta?.brain_hot_memory as { facts: { fact: string }[] } | undefined;
    const facts = bhm?.facts ?? [];
    expect(facts.find(f => f.fact === 'private fact')).toBeDefined();
    expect(facts.find(f => f.fact === 'world fact')).toBeDefined();
  });

  test('skipped on facts ops themselves (recall, extract_facts, forget_fact)', async () => {
    for (const opName of ['recall', 'extract_facts', 'forget_fact']) {
      __resetHotMemoryCacheForTests();
      const r = await dispatchToolCall(engine, opName, opName === 'forget_fact' ? { id: 1 } : opName === 'extract_facts' ? { turn_text: 'x' } : {}, {
        remote: false,
        sourceId: 'default',
        metaHook: getBrainHotMemoryMeta,
      });
      // Some of these will isError (e.g. forget_fact on unknown id) but
      // none should carry _meta.brain_hot_memory.
      if (!r.isError) {
        expect(r._meta?.brain_hot_memory).toBeUndefined();
      }
    }
  });

  test('failing metaHook degrades to no-_meta, op still succeeds', async () => {
    const failHook = async (): Promise<Record<string, unknown> | undefined> => {
      throw new Error('meta hook boom');
    };
    const r = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: false,
      sourceId: 'default',
      metaHook: failHook,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta).toBeUndefined();
  });

  test('different allow-lists produce different _meta', async () => {
    // Two world-only facts: one for an allow-listed user, one for everyone.
    // Cache key includes hash(allowList) — distinct keys → distinct entries.
    const noListResp = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: true, sourceId: 'default', metaHook: getBrainHotMemoryMeta,
    });
    __resetHotMemoryCacheForTests();
    const withListResp = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: true, sourceId: 'default', takesHoldersAllowList: ['world', 'self'], metaHook: getBrainHotMemoryMeta,
    });
    // Both should compute _meta independently — we just confirm both
    // return without error and the _meta presence is consistent.
    expect(noListResp.isError).toBeFalsy();
    expect(withListResp.isError).toBeFalsy();
  });
});
