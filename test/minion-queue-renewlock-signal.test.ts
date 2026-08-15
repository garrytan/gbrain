/**
 * issue #6 — `MinionQueue.renewLock` forwards its optional AbortSignal to
 * `engine.executeRawDirect` so the lock-renewal tick's timeout race can
 * CANCEL a hung UPDATE (postgres.js `.cancel()`) instead of abandoning it on
 * a checked-out pool slot.
 *
 * Hermetic: stub engine object literal (`as unknown as BrainEngine`), no DB —
 * the worker-conn-resilience-1720 pattern.
 */

import { describe, expect, test } from 'bun:test';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeCaptureEngine() {
  const calls: Array<{
    sql: string;
    params: unknown[] | undefined;
    opts: { signal?: AbortSignal } | undefined;
  }> = [];
  const engine = {
    kind: 'postgres',
    executeRawDirect: async (
      sql: string,
      params?: unknown[],
      opts?: { signal?: AbortSignal },
    ) => {
      calls.push({ sql, params, opts });
      return [{ id: 1 }];
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

describe('MinionQueue.renewLock signal forwarding (issue #6)', () => {
  test('forwards opts.signal to executeRawDirect', async () => {
    const { engine, calls } = makeCaptureEngine();
    const queue = new MinionQueue(engine);
    const ac = new AbortController();

    const ok = await queue.renewLock(7, 'tok-xyz', 30_000, { signal: ac.signal });

    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain('UPDATE minion_jobs SET lock_until');
    expect(calls[0].params).toEqual([30_000, 7, 'tok-xyz']);
    expect(calls[0].opts?.signal).toBe(ac.signal);
  });

  test('legacy 3-arg call still works (opts undefined)', async () => {
    const { engine, calls } = makeCaptureEngine();
    const queue = new MinionQueue(engine);

    const ok = await queue.renewLock(7, 'tok-xyz', 30_000);

    expect(ok).toBe(true);
    expect(calls[0].opts).toBeUndefined();
  });

  test('token-fence miss returns false regardless of signal', async () => {
    const engine = {
      kind: 'postgres',
      executeRawDirect: async () => [],
    } as unknown as BrainEngine;
    const queue = new MinionQueue(engine);
    const ac = new AbortController();

    const ok = await queue.renewLock(7, 'tok-stale', 30_000, { signal: ac.signal });
    expect(ok).toBe(false);
  });
});
