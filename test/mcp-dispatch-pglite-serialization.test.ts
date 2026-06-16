/**
 * Regression coverage for PGLite-backed MCP dispatch.
 *
 * Hermes can issue multiple MCP tool calls in parallel. PGLite is a single-process
 * embedded database, so overlapping handlers against the same engine can trip
 * low-level WAL errors such as "XLogBeginInsert was already called". The MCP
 * dispatcher serializes PGLite calls while leaving Postgres concurrency intact.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { dispatchToolCall, _resetPgliteDispatchQueueForTest } from '../src/mcp/dispatch.ts';
import { operations, type Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const TEST_OP = '__test_serialized_dispatch';

function removeTestOp(): void {
  let idx = operations.findIndex(op => op.name === TEST_OP);
  while (idx >= 0) {
    operations.splice(idx, 1);
    idx = operations.findIndex(op => op.name === TEST_OP);
  }
}

afterEach(() => {
  removeTestOp();
  _resetPgliteDispatchQueueForTest();
});

describe('dispatchToolCall PGLite serialization', () => {
  test('serializes concurrent MCP handlers for a PGLite engine', async () => {
    removeTestOp();
    let active = 0;
    let maxActive = 0;
    const op: Operation = {
      name: TEST_OP,
      description: 'test-only operation that detects overlap',
      params: {},
      handler: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        return { ok: true };
      },
    };
    operations.push(op);

    const engine = { kind: 'pglite' } as unknown as BrainEngine;
    await Promise.all([
      dispatchToolCall(engine, TEST_OP, {}),
      dispatchToolCall(engine, TEST_OP, {}),
      dispatchToolCall(engine, TEST_OP, {}),
    ]);

    expect(maxActive).toBe(1);
  });

  test('does not serialize concurrent handlers for a Postgres engine', async () => {
    removeTestOp();
    let active = 0;
    let maxActive = 0;
    const op: Operation = {
      name: TEST_OP,
      description: 'test-only operation that detects overlap',
      params: {},
      handler: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        return { ok: true };
      },
    };
    operations.push(op);

    const engine = { kind: 'postgres' } as unknown as BrainEngine;
    await Promise.all([
      dispatchToolCall(engine, TEST_OP, {}),
      dispatchToolCall(engine, TEST_OP, {}),
      dispatchToolCall(engine, TEST_OP, {}),
    ]);

    expect(maxActive).toBeGreaterThan(1);
  });
});
