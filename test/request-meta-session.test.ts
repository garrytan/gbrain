/**
 * CX2-11: `requestMetaSessionId` — the one reader of the request-level
 * `_meta.session_id` that both MCP transports (stdio and HTTP) thread into
 * dispatch.
 *
 * Protects: the session is read from beside `arguments` in `request.params`;
 * absent, empty and non-string values yield no session.
 * Fails when: the helper reads the wrong field or lets an empty or non-string
 * value through as a session.
 * Why new: the HTTP threading is pinned through the real transport in
 * serve-http-mcp-dispatch-context.serial.test.ts; these input edge cases are
 * not worth an HTTP round-trip each.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { requestMetaSessionId } from '../src/mcp/dispatch.ts';
import {
  HOT_MEMORY_CACHE_MAX_ENTRIES,
  __hotMemoryCacheForTests,
  __resetHotMemoryCacheForTests,
  getBrainHotMemoryMeta,
} from '../src/core/facts/meta-hook.ts';
import type { OperationContext } from '../src/core/operations.ts';

describe('requestMetaSessionId', () => {
  test('reads the session beside the arguments', () => {
    expect(requestMetaSessionId({ name: 'remember', arguments: {}, _meta: { session_id: 'sess-1' } })).toBe('sess-1');
  });

  test('absent, empty or non-string is no session', () => {
    expect(requestMetaSessionId({ name: 'remember', arguments: {} })).toBeUndefined();
    expect(requestMetaSessionId({ _meta: { session_id: '' } })).toBeUndefined();
    expect(requestMetaSessionId({ _meta: { session_id: 7 } })).toBeUndefined();
    expect(requestMetaSessionId(undefined)).toBeUndefined();
  });

  test('reads only the request level; arguments-level _meta stays the dispatch fallback', () => {
    expect(requestMetaSessionId({ name: 'remember', arguments: { _meta: { session_id: 'in-args' } } })).toBeUndefined();
  });
});

// FM17: the session id is client-controlled over both transports, and the
// hot-memory cache folds it into its key. The cache's own bound must hold when
// a remote client mints a fresh id on every call. Coverage-only: the bound
// predates request-level session threading; this pins it under remote ids.
describe('per-session hot-memory cache stays bounded under remote session ids', () => {
  afterEach(() => __resetHotMemoryCacheForTests());

  test('2000 random remote session ids leave at most HOT_MEMORY_CACHE_MAX_ENTRIES entries', async () => {
    __resetHotMemoryCacheForTests();
    const engine = {
      executeRaw: async () => [{ n: 0, at: null, generation: '0' }],
      listFactsBySession: async () => [],
      listFactsSince: async () => [],
    };
    for (let i = 0; i < 2000; i++) {
      const sessionId = requestMetaSessionId({ name: 'search', arguments: {}, _meta: { session_id: crypto.randomUUID() } });
      expect(sessionId).toBeDefined();
      const ctx = { engine, remote: true, sourceId: 'default', sessionId } as unknown as OperationContext;
      await getBrainHotMemoryMeta('search', ctx);
    }
    expect(HOT_MEMORY_CACHE_MAX_ENTRIES).toBe(1000);
    expect(__hotMemoryCacheForTests().size).toBe(HOT_MEMORY_CACHE_MAX_ENTRIES);
  });
});
