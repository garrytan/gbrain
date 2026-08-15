/**
 * Dispatch-layer localOnly backstop (WP1/D7).
 *
 * localOnly ops reach the operator's filesystem. Transport locality decides
 * dispatch: 'stdio' (local pipe) passes the backstop; 'http' and an UNSET
 * marker are denied fail-closed with the same envelope as a nonexistent op.
 * The trust axis (`remote`) is deliberately not consulted — stdio dispatches
 * with remote:true and still keeps its localOnly surface.
 */

import { describe, test, expect } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Minimal engine stub: the backstop fires before any handler/engine call on
// the deny paths; on the stdio pass path the handler may touch the engine,
// and an empty result set is fine — the assertion is only that dispatch got
// PAST the backstop (i.e. the error, if any, is not unknown_tool).
const engineStub = {
  kind: 'postgres',
  executeRaw: async () => [],
  sql: async () => [],
} as unknown as BrainEngine;

const A_LOCAL_ONLY = 'file_list';

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('dispatch localOnly backstop (WP1/D7)', () => {
  test('the fixture op is still declared localOnly', () => {
    const op = operations.find(o => o.name === A_LOCAL_ONLY);
    expect(op?.localOnly).toBe(true);
  });

  test("transport 'http' → unknown_tool, byte-identical to a nonexistent op", async () => {
    const denied = await dispatchToolCall(engineStub, A_LOCAL_ONLY, {}, {
      remote: true, transport: 'http', sourceId: 'default',
    });
    expect(denied.isError).toBe(true);
    const noSuchOp = await dispatchToolCall(engineStub, 'no_such_op_xyz', {}, {
      remote: true, transport: 'http', sourceId: 'default',
    });
    expect(parsed(denied).error).toBe('unknown_tool');
    // Same envelope shape as a nonexistent op: no existence oracle.
    expect(parsed(denied).error).toBe(parsed(noSuchOp).error);
  });

  test('unset transport marker → denied fail-closed', async () => {
    const denied = await dispatchToolCall(engineStub, A_LOCAL_ONLY, {}, {
      remote: true, sourceId: 'default',
    });
    expect(denied.isError).toBe(true);
    expect(parsed(denied).error).toBe('unknown_tool');
  });

  test("transport 'stdio' → passes the backstop (D7: stdio is the local surface)", async () => {
    const result = await dispatchToolCall(engineStub, A_LOCAL_ONLY, {}, {
      remote: true, transport: 'stdio', sourceId: 'default',
    });
    // The stub engine can't run the real handler; the contract under test is
    // only that stdio got PAST the backstop — any failure is a handler-level
    // error, never the unknown_tool denial.
    if (result.isError) {
      expect(parsed(result).error).not.toBe('unknown_tool');
    }
  });
});
