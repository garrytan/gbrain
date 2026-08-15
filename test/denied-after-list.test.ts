/**
 * T14 (amendment 33 + D10) — the honest-catalog metric's denial classifier.
 *
 * `isListLevelDenialEnvelope` decides which error envelopes serve-http logs
 * as status='denied_after_list' (the wave's trend-to-zero metric). Pins:
 *   - publish-gate call-time backstop (detail 'config_key=...') → counted
 *   - bound-client fence OP-level deny (detail 'fence=op') → counted
 *   - argument-level slug-fence denials (no marker) → EXCLUDED (D10)
 *   - non-permission errors → excluded
 *
 * The fence + gate cases run through the real dispatchToolCall so the
 * envelopes are the ones serve-http actually parses.
 *
 * `requestLogStatusForResult` is the ONE status decision serve-http persists
 * per tools/call row (success / success_with_warnings / denied_after_list /
 * error) — pinned pure here. ROW-LEVEL assertions (actual mcp_request_log
 * inserts, plus the tools/list `params.tool_count` contract) live in the
 * Postgres-host e2e (test/e2e/serve-http-oauth.test.ts — extension filed in
 * TODOS.md).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  dispatchToolCall,
  isListLevelDenialEnvelope,
  requestLogStatusForResult,
  type ToolResult,
} from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Publish gates OFF on the DB plane (wins over any dev-machine file config)
  // so the advisor gate backstop fires deterministically.
  await engine.setConfig('mcp.publish_advisor', 'false');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

function boundAuth(): AuthInfo {
  return { token: 't', clientId: 'bound-client', scopes: ['read', 'write'], boundSlugPrefixes: ['notes/'] } as AuthInfo;
}

const HTTP = { remote: true, transport: 'http' as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

describe('isListLevelDenialEnvelope (pure)', () => {
  test('counts config_key= gate denials and fence=op fence denials', () => {
    expect(isListLevelDenialEnvelope({ error: 'permission_denied', detail: 'config_key=mcp.publish_skills' })).toBe(true);
    expect(isListLevelDenialEnvelope({ error: 'permission_denied', detail: 'fence=op' })).toBe(true);
  });
  test('excludes everything else', () => {
    expect(isListLevelDenialEnvelope({ error: 'permission_denied' })).toBe(false); // no marker = argument-level
    expect(isListLevelDenialEnvelope({ error: 'permission_denied', detail: 'something_else' })).toBe(false);
    expect(isListLevelDenialEnvelope({ error: 'invalid_params', detail: 'config_key=x' })).toBe(false);
    expect(isListLevelDenialEnvelope({ error: 'unknown_tool' })).toBe(false);
    expect(isListLevelDenialEnvelope(null)).toBe(false);
    expect(isListLevelDenialEnvelope('permission_denied')).toBe(false);
  });
});

describe('requestLogStatusForResult (pure — the persisted status decision)', () => {
  const ok = (extra: Partial<ToolResult> = {}): ToolResult => ({
    content: [{ type: 'text', text: '{}' }],
    ...extra,
  });

  test('plain success → success', () => {
    expect(requestLogStatusForResult(ok())).toBe('success');
    // Empty warnings array is NOT a warn state.
    expect(requestLogStatusForResult(ok({ _meta: { warnings: [] } }))).toBe('success');
    // Unrelated _meta payloads do not flip the status.
    expect(requestLogStatusForResult(ok({ _meta: { brain_hot_memory: { x: 1 } } }))).toBe('success');
  });

  test('success with non-empty _meta.warnings → success_with_warnings', () => {
    const res = ok({ _meta: { warnings: [{ code: 'unknown_param', param: 'zz' }] } });
    expect(requestLogStatusForResult(res)).toBe('success_with_warnings');
  });

  test('list-level denial envelopes → denied_after_list', () => {
    const gate: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied', detail: 'config_key=mcp.publish_skills' }) }],
    };
    const fence: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied', detail: 'fence=op' }) }],
    };
    expect(requestLogStatusForResult(gate)).toBe('denied_after_list');
    expect(requestLogStatusForResult(fence)).toBe('denied_after_list');
  });

  test('other errors (argument-level denials, op errors, unparseable content) → error', () => {
    const argLevel: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied' }) }],
    };
    const opError: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: 'x' }) }],
    };
    const garbage: ToolResult = { isError: true, content: [{ type: 'text', text: 'not json' }] };
    const empty: ToolResult = { isError: true, content: [] };
    expect(requestLogStatusForResult(argLevel)).toBe('error');
    expect(requestLogStatusForResult(opError)).toBe('error');
    expect(requestLogStatusForResult(garbage)).toBe('error');
    expect(requestLogStatusForResult(empty)).toBe('error');
  });
});

describe('real envelopes through dispatchToolCall', () => {
  test('publish-gate backstop (advisor, gate off, remote) → counted', async () => {
    const res = await dispatchToolCall(engine, 'advisor', {}, { ...HTTP });
    expect(res.isError).toBe(true);
    const p = parsed(res);
    expect(p.error).toBe('permission_denied');
    expect(p.detail).toBe('config_key=mcp.publish_advisor');
    expect(isListLevelDenialEnvelope(p)).toBe(true);
  });

  test('bound-client fence OP-level deny (unfenceable write op) → counted', async () => {
    // forget_fact writes by numeric fact id (not a slug) — never available
    // to slug-bound clients; the dispatch fence denies at the op level.
    const res = await dispatchToolCall(engine, 'forget_fact', { id: 1 }, { ...HTTP, auth: boundAuth() });
    expect(res.isError).toBe(true);
    const p = parsed(res);
    expect(p.error).toBe('permission_denied');
    expect(p.detail).toBe('fence=op');
    expect(isListLevelDenialEnvelope(p)).toBe(true);
  });

  test('argument-level slug-fence deny (listed op, out-of-fence slug) → excluded (D10)', async () => {
    // put_page IS fence-allowed (listed for bound clients); an out-of-prefix
    // slug denies at the ARGUMENT level — legitimate, not a catalog lie.
    const res = await dispatchToolCall(
      engine,
      'put_page',
      { slug: 'other/page', title: 'x', content: 'x' },
      { ...HTTP, auth: boundAuth() },
    );
    expect(res.isError).toBe(true);
    const p = parsed(res);
    expect(p.error).toBe('permission_denied');
    expect(isListLevelDenialEnvelope(p)).toBe(false);
  });
});
