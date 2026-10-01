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

import { describe, expect, test } from 'bun:test';
import { requestMetaSessionId } from '../src/mcp/dispatch.ts';

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
