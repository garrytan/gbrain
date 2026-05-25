import { describe, expect, test, beforeEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  _resetTrackRetrievalCacheForTests,
  awaitPendingLastRetrievedWrites,
  bumpLastRetrievedAt,
} from '../src/core/last-retrieved.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('last retrieved write-back shutdown drain', () => {
  beforeEach(async () => {
    _resetTrackRetrievalCacheForTests();
    await awaitPendingLastRetrievedWrites();
  });

  test('drains in-flight write-backs before CLI engine disconnect', async () => {
    const gate = deferred();
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const engine = {
      getConfig: async () => null,
      executeRaw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        await gate.promise;
      },
    } as unknown as BrainEngine;

    bumpLastRetrievedAt(engine, [1, 2]);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('UPDATE pages');
    expect(calls[0].params).toEqual([[1, 2]]);

    let drained = false;
    const drain = awaitPendingLastRetrievedWrites().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    gate.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  test('does not surface best-effort write-back failures during drain', async () => {
    const engine = {
      getConfig: async () => null,
      executeRaw: async () => {
        throw new Error('simulated write-back failure');
      },
    } as unknown as BrainEngine;

    bumpLastRetrievedAt(engine, [3]);
    await expect(awaitPendingLastRetrievedWrites()).resolves.toBeUndefined();
  });

  test('times out instead of hanging forever on a stuck write-back', async () => {
    const gate = deferred();
    const engine = {
      getConfig: async () => null,
      executeRaw: async () => {
        await gate.promise;
      },
    } as unknown as BrainEngine;

    bumpLastRetrievedAt(engine, [4]);
    await expect(awaitPendingLastRetrievedWrites(1)).resolves.toBeUndefined();

    gate.resolve();
    await awaitPendingLastRetrievedWrites(0);
  });
});
