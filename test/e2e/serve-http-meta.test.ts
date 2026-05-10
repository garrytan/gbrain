/**
 * v0.31 E2E — eE1 regression: HTTP MCP transport gets _meta hot memory.
 *
 * Pins the D12 refactor: serve-http.ts:801 now goes through dispatchToolCall
 * so HTTP-token clients see the same _meta.brain_hot_memory as stdio MCP.
 *
 * Tests the dispatchToolCall path with the same opts shape serve-http.ts
 * uses (remote=true, sourceId, takesHoldersAllowList, metaHook). End-to-end
 * full HTTP server boot is heavier than the v0.31 ship gate needs; the
 * dispatch-level test pins the contract that the refactor preserves.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
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
    { fact: 'http world fact', kind: 'fact', entity_slug: 'serve-http-test', visibility: 'world', source: 'test' },
    { source_id: 'default' },
  );
});

afterAll(async () => { if (RUN) await teardownDB(); });

d('serve-http dispatch parity (eE1)', () => {
  test('HTTP-shaped dispatch gets _meta on success', async () => {
    if (!RUN) return;
    __resetHotMemoryCacheForTests();
    // Mirror the exact opts shape serve-http.ts:801 passes:
    const r = await dispatchToolCall(getEngine(), 'get_stats', {}, {
      remote: true,
      sourceId: 'default',
      takesHoldersAllowList: ['world'],
      metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.brain_hot_memory).toBeDefined();
  });

  test('error path: dispatch returns isError without throwing through serve-http', async () => {
    if (!RUN) return;
    const r = await dispatchToolCall(getEngine(), 'unknown_op_name', {}, {
      remote: true,
      sourceId: 'default',
      takesHoldersAllowList: ['world'],
      metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBe(true);
  });
});
