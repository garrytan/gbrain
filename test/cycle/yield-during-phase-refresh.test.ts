// v0.41.19.0 — T3 of ops-fix-wave (codex catch).
//
// Pins that buildYieldDuringPhase actually calls lock.refresh() AND the
// outer hook on every fire. Codex caught that the prior plan's "use
// yieldBetweenPhases" claim was false — yieldBetweenPhases is just
// setImmediate() from jobs.ts/autopilot.ts and never refreshes the
// cycle DB lock. Combined with TTL=5min (T2), a missing refresh would
// lose the lock mid-phase. The closure built by buildYieldDuringPhase
// is the active refresh path.

import { describe, test, expect } from 'bun:test';
import { buildYieldDuringPhase } from '../../src/core/cycle.ts';
import type { LockHandle } from '../../src/core/cycle.ts';

function makeMockLock(): { lock: LockHandle; refreshCount: number; releaseCount: number } {
  const state = { refreshCount: 0, releaseCount: 0 };
  const lock: LockHandle = {
    refresh: async () => { state.refreshCount++; },
    release: async () => { state.releaseCount++; },
  };
  return {
    lock,
    get refreshCount() { return state.refreshCount; },
    get releaseCount() { return state.releaseCount; },
  };
}

describe('buildYieldDuringPhase (T3 codex fix)', () => {
  test('returns undefined when both lock and outer are absent', () => {
    const fn = buildYieldDuringPhase(null);
    expect(fn).toBeUndefined();
  });

  test('returns a function when lock is present', () => {
    const { lock } = makeMockLock();
    const fn = buildYieldDuringPhase(lock);
    expect(typeof fn).toBe('function');
  });

  test('returns a function when only outer is present', () => {
    const fn = buildYieldDuringPhase(null, async () => {});
    expect(typeof fn).toBe('function');
  });

  test('each fire calls lock.refresh exactly once', async () => {
    const tracker = makeMockLock();
    const fn = buildYieldDuringPhase(tracker.lock);
    expect(fn).toBeDefined();
    await fn!();
    expect(tracker.refreshCount).toBe(1);
    await fn!();
    expect(tracker.refreshCount).toBe(2);
    await fn!();
    expect(tracker.refreshCount).toBe(3);
  });

  test('each fire calls the outer hook AFTER lock.refresh', async () => {
    const tracker = makeMockLock();
    const callOrder: string[] = [];
    const outer = async () => { callOrder.push('outer'); };
    const fn = buildYieldDuringPhase({
      ...tracker.lock,
      refresh: async () => { callOrder.push('refresh'); tracker.lock.refresh(); },
    }, outer);
    await fn!();
    expect(callOrder).toEqual(['refresh', 'outer']);
  });

  test('lock.refresh throw is non-fatal — outer still runs', async () => {
    let outerCalled = false;
    const badLock: LockHandle = {
      refresh: async () => { throw new Error('lock stolen'); },
      release: async () => {},
    };
    const fn = buildYieldDuringPhase(badLock, async () => { outerCalled = true; });
    // Must not throw.
    await fn!();
    // Outer should still have run even though refresh threw.
    expect(outerCalled).toBe(true);
  });

  test('outer hook throw is non-fatal', async () => {
    const tracker = makeMockLock();
    const fn = buildYieldDuringPhase(tracker.lock, async () => {
      throw new Error('outer kaboom');
    });
    // Must not throw.
    await fn!();
    // Refresh still fired despite outer failure.
    expect(tracker.refreshCount).toBe(1);
  });

  test('never calls lock.release (release stays separate from refresh)', async () => {
    const tracker = makeMockLock();
    const fn = buildYieldDuringPhase(tracker.lock);
    for (let i = 0; i < 5; i++) await fn!();
    expect(tracker.refreshCount).toBe(5);
    expect(tracker.releaseCount).toBe(0);
  });
});
