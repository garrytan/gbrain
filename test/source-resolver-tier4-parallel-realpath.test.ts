/**
 * #4091-class root-cause fix — tier-4 registered-source realpath resolution
 * must overlap I/O across sources, not serialize behind each other.
 *
 * Discovered while investigating why `gbrain takes-list` (and any other
 * CLI command reaching tier 4 of source resolution with no --source/env/
 * dotfile match) took ~40s on a brain with 9 registered sources whose
 * local_path all lived under a directory macOS's on-access security scan
 * makes slow to `realpath()`: each source added its own multi-second delay
 * because the original code called the SYNCHRONOUS `realpathSync` in a
 * plain `for` loop — `Promise.all`-wrapping a sync call does not
 * parallelize it, since a sync call blocks the whole event loop for its
 * full duration regardless of how many promises surround it. The fix
 * switches to `fs.promises.realpath` (`realpathOrResolveAsync`) and
 * resolves every source's path via a single `Promise.all`, so tier 4's
 * cost is bounded by the SLOWEST single source, not their sum.
 *
 * This test can't reproduce the real macOS-scan slowness portably/in CI,
 * so it spies on `realpathOrResolveAsync` to prove concurrency directly:
 * every mocked call increments an in-flight counter and hangs on its own
 * releaser (never auto-resolving), so the test can assert ALL N+1 calls
 * (cwd + every registered source) were issued before ANY of them settled.
 * This is deterministic — no wall-clock/timing assertion, so it can't flake
 * under CI load, timer throttling, or coverage instrumentation (the wall
 * clock version of this test hit exactly that risk in review).
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { resolveSourceId, resolveSourceWithTier } from '../src/core/source-resolver.ts';
import * as pathConfine from '../src/core/path-confine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeStub(paths: Array<{ id: string; local_path: string }>): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      // Matches both query shapes of listRegisteredLocalPathSources (#3880):
      // the archived-column query and its pre-v34 column-less fallback. Rows
      // carry no `archived` key here → treated as active.
      if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) {
        return paths as unknown as T[];
      }
      // #4368-added archival gate: resolveSourceId/resolveSourceWithTier call
      // assertSourceExists on the tier-4 match before returning it. This test
      // only exercises resolution ordering/concurrency, not archival — every
      // id the resolver checks is treated as active.
      if (sql.includes('SELECT id FROM sources WHERE id = $1 AND archived = false')) {
        return [{ id: params?.[0] }] as unknown as T[];
      }
      return [] as unknown as T[];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

describe('resolveSourceWithTier — tier 4 realpath resolution is parallel, not serial (#4091-class)', () => {
  test('all N+1 realpath calls (cwd + every registered source) are in flight together before any settles', async () => {
    const N = 6;
    const paths = Array.from({ length: N }, (_, i) => ({ id: `src${i}`, local_path: `/slow/path${i}` }));
    const engine = makeStub(paths);

    let inFlight = 0;
    let maxInFlight = 0;
    const releasers: Array<() => void> = [];

    const spy = spyOn(pathConfine, 'realpathOrResolveAsync').mockImplementation((p: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<string>((resolvePromise) => {
        releasers.push(() => {
          inFlight--;
          resolvePromise(p);
        });
      });
    });

    try {
      const resultPromise = resolveSourceWithTier(engine, null, '/slow/path3/nested');
      // Let the microtask queue drain so every Promise.all-issued call has
      // started (but none have been released yet — they all hang on their
      // own releaser above). If the tier-4 loop were serial, only the FIRST
      // call would be in flight at this point; the rest would not even have
      // been issued yet, since each `await` blocks starting the next one.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // cwd's own realpath + one per registered source, all outstanding at once.
      expect(maxInFlight).toBe(N + 1);
      expect(inFlight).toBe(N + 1); // none settled yet either

      // Release everything and let resolution complete.
      for (const release of releasers) release();
      const result = await resultPromise;

      expect(result.source_id).toBe('src3');
      expect(result.tier).toBe('local_path');
    } finally {
      spy.mockRestore();
    }
  });

  test('control: same scenario without the spy still resolves correctly (regression guard)', async () => {
    const paths = [
      { id: 'gstack', local_path: '/work/gstack' },
      { id: 'other', local_path: '/work/other' },
    ];
    const engine = makeStub(paths);
    const result = await resolveSourceWithTier(engine, null, '/work/gstack/src');
    expect(result.source_id).toBe('gstack');
    expect(result.tier).toBe('local_path');
  });

  test('resolveSourceId (the other tier-4 caller) shares the same fix — parity check', async () => {
    // resolveSourceWithTier is covered directly above; resolveSourceId shares
    // resolveRegisteredPathMatch under the hood, so this pins that the
    // refactor didn't let the two entry points drift.
    const paths = [
      { id: 'gstack', local_path: '/work/gstack' },
      { id: 'other', local_path: '/work/other' },
    ];
    const engine = makeStub(paths);
    const id = await resolveSourceId(engine, null, '/work/gstack/src');
    expect(id).toBe('gstack');
  });

  test('a genuine tie (two sources sharing the identical resolved path) keeps the pre-refactor first-row-wins order', async () => {
    // The registered-sources query has no ORDER BY, so a real tie (both
    // candidates resolve to the SAME length AND the same matched prefix) is
    // broken by array/database row order — unchanged by the Promise.all
    // refactor (Promise.all preserves input order). Two DIFFERENT local_path
    // strings of equal length are not a tie unless both are prefixes of cwd;
    // the simplest genuine tie is a duplicate registration (same path twice),
    // which is a real edge case (an operator registering a source twice, or
    // two ids sharing a symlinked vault).
    const paths = [
      { id: 'first', local_path: '/work/same' },
      { id: 'second', local_path: '/work/same' },
    ];
    const engine = makeStub(paths);
    const result = await resolveSourceWithTier(engine, null, '/work/same/nested');
    expect(result.source_id).toBe('first');
  });
});
