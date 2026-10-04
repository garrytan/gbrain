/**
 * Agent operator contract v1 (A2): every op declares `mutating` and
 * `idempotent`. MCP annotations (`readOnlyHint`, `idempotentHint`),
 * `--tools-json` and the safe-recovery rule (`retryable` only for idempotent
 * writes) all read these tags, so an untagged op would silently fall back to
 * "unknown effect".
 */
import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { isPersistenceIpcMutation } from '../src/core/persistence/ipc.ts';

describe('op mutation tags', () => {
  test('every op sets mutating and idempotent as booleans', () => {
    const missing = operations.filter(op => typeof op.mutating !== 'boolean' || typeof op.idempotent !== 'boolean').map(op => op.name);
    expect(missing).toEqual([]);
  });

  test('a non-mutating op is idempotent by definition', () => {
    expect(operations.filter(op => op.mutating === false && op.idempotent !== true).map(op => op.name)).toEqual([]);
  });

  test('journaled persistence mutations are mutating and idempotent (same request_id, same effect)', () => {
    const wrong = operations.filter(op => isPersistenceIpcMutation(op.name) && 'request_id' in op.params && !(op.mutating && op.idempotent));
    expect(wrong.map(op => op.name)).toEqual([]);
  });

  test('ops that enqueue or spend are not idempotent', () => {
    for (const name of ['submit_job', 'submit_agent', 'think', 'sync_brain', 'migrate_embeddings']) {
      const op = operations.find(o => o.name === name)!;
      expect({ name, mutating: op.mutating, idempotent: op.idempotent }).toEqual({ name, mutating: true, idempotent: false });
    }
  });
});
