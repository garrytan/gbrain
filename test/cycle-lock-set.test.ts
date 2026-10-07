import { describe, expect, test } from 'bun:test';
import { acquireCycleLockSet } from '../src/core/cycle/lock-set.ts';

function fixture() {
  const calls: string[] = [];
  const live = new Set<string>();
  const lost = new Set<string>();
  const acquire = async (id: string) => {
    calls.push(`acquire:${id}`);
    if (live.has(id)) return null;
    live.add(id);
    return {
      refresh: async () => { calls.push(`refresh:${id}`); return !lost.has(id); },
      release: async () => { calls.push(`release:${id}`); live.delete(id); },
    };
  };
  return { calls, live, lost, acquire };
}

describe('cycle lease set', () => {
  test('deduplicates the unscoped maintenance lease and releases in reverse order', async () => {
    const f = fixture();
    const result = await acquireCycleLockSet(['source', 'global', 'global'], f.acquire);
    expect(result.handle).not.toBeNull();
    expect(await result.handle!.refresh()).toBe(true);
    await result.handle!.release();
    expect(await result.handle!.refresh()).toBe(false);
    expect(f.calls).toEqual(['acquire:source', 'acquire:global', 'refresh:source', 'refresh:global', 'release:global', 'release:source']);
    expect(f.live.size).toBe(0);
  });

  test('busy global lease rolls back source acquisition without releasing the other owner', async () => {
    const f = fixture();
    f.live.add('global');
    const result = await acquireCycleLockSet(['source', 'global'], f.acquire);
    expect(result).toEqual({ handle: null, busyLockId: 'global' });
    expect([...f.live]).toEqual(['global']);
    expect(f.calls).toEqual(['acquire:source', 'acquire:global', 'release:source']);
  });

  test('acquisition error rolls back every acquired lease and preserves the error', async () => {
    const f = fixture();
    const failure = new Error('synthetic acquire failure');
    await expect(acquireCycleLockSet(['source', 'global'], async id => {
      if (id === 'global') throw failure;
      return f.acquire(id);
    })).rejects.toBe(failure);
    expect(f.live.size).toBe(0);
  });

  test('loss of either fence invalidates the set, without renewing later leases', async () => {
    for (const id of ['source', 'global']) {
      const f = fixture();
      const result = await acquireCycleLockSet(['source', 'global'], f.acquire);
      f.lost.add(id);
      expect(await result.handle!.refresh()).toBe(false);
      expect(f.calls.filter(call => call.startsWith('refresh:'))).toEqual(
        id === 'source' ? ['refresh:source'] : ['refresh:source', 'refresh:global'],
      );
      await result.handle!.release();
    }
  });

  test('release error still attempts the remaining leases', async () => {
    const f = fixture();
    const failure = new Error('synthetic release failure');
    const result = await acquireCycleLockSet(['source', 'global'], async id => {
      const lease = await f.acquire(id);
      if (id !== 'global') return lease;
      return { refresh: lease!.refresh, release: async () => { throw failure; } };
    });
    await expect(result.handle!.release()).rejects.toBe(failure);
    expect(f.live.has('source')).toBe(false);
  });
});
