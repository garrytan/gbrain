/**
 * hardenFunctionSearchPaths (#7688): a concurrent update of the same pg_proc row ("tuple concurrently updated", e.g.
 * `apply-migrations --force-schema` beside another process's boot) is retried, since the step is idempotent; and a
 * hardening that committed but could not list what it left returns null instead of reading as "not restored".
 */
import { describe, expect, test } from 'bun:test';
import { hardenFunctionSearchPaths } from '../src/core/function-search-path.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function stubEngine(opts: { failTransactions: number; listFailsAfterCommit?: boolean }) {
  const state = { transactions: 0, committed: false };
  const engine = {
    kind: 'pglite',
    executeRaw: async () => {
      if (!state.committed) return [{ sig: 'gbrain_try_jsonb(text)' }];
      if (opts.listFailsAfterCommit) throw new Error('connection reset');
      return [];
    },
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      state.transactions++;
      if (state.transactions <= opts.failTransactions) throw new Error('tuple concurrently updated');
      await fn({ executeRaw: async () => [], runMigration: async () => {} });
      state.committed = true;
    },
  } as unknown as BrainEngine;
  return { engine, state };
}

describe('hardenFunctionSearchPaths (#7688)', () => {
  test('a concurrent pg_proc update is retried and the hardening completes', async () => {
    const { engine, state } = stubEngine({ failTransactions: 1 });
    expect(await hardenFunctionSearchPaths(engine)).toEqual([]);
    expect(state.transactions).toBe(2);
  });

  test('a concurrent update that keeps recurring still surfaces after the bounded attempts', async () => {
    const { engine, state } = stubEngine({ failTransactions: 99 });
    await expect(hardenFunctionSearchPaths(engine)).rejects.toThrow('tuple concurrently updated');
    expect(state.transactions).toBe(3);
  });

  test('a committed hardening whose follow-up listing fails returns null, not an error', async () => {
    const { engine } = stubEngine({ failTransactions: 0, listFailsAfterCommit: true });
    expect(await hardenFunctionSearchPaths(engine)).toBeNull();
  });
});
