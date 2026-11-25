/**
 * The refresh writer (persistence/worktree-refresh.ts `refreshWorktree`, behind `gbrain sources refresh`) on an engine
 * without raw SQL.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on an engine whose capability set lacks `raw_sql` and `managed_persistence` (a user's Rust brain, while the
 *    hold is on) the refresh writer refuses `engine_capability_missing` with reason `raw_sql`, naming itself, before it reads
 *    or writes anything. With `managed_persistence` reported (the hold lifted on a test engine) it runs on the typed refresh
 *    store, so it no longer stops at that check.
 *  - Regression: the store held managed_persistence back while the refresh writer was untyped. With it reported, a
 *    refresh on a Rust brain would start its run and stop on the first raw statement, part way through. Fail-first: on
 *    the parent head 524768a179 the call reaches past the capability check and touches another engine member, which
 *    this test's engine refuses with a different error.
 *  - Why existing coverage misses it: the refresh tests run on PGLite and Postgres, which serve raw SQL.
 *  - Seam: an engine object with only a capability set; any other member it is asked for throws, so a refusal that
 *    came after a read cannot pass.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';

function rustShaped(managed = false): { engine: BrainEngine; touched: PropertyKey[] } {
  const touched: PropertyKey[] = [];
  const capabilities = new Set(['transactions', 'persistence_journal', ...(managed ? ['managed_persistence'] : [])]);
  const engine = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'capabilities') return capabilities;
      if (prop === 'then') return undefined;
      touched.push(prop);
      throw new Error(`the refresh writer touched ${String(prop)} before its capability check`);
    },
  }) as unknown as BrainEngine;
  return { engine, touched };
}

describe('the refresh writer on an engine without raw SQL', () => {
  test('refuses by name with reason raw_sql, before any engine member', async () => {
    const { engine, touched } = rustShaped();
    const refusal = await refreshWorktree(engine, 'work').then(() => null, (e: { code?: string; reason?: string; message?: string }) => e);
    expect({ code: refusal?.code, reason: refusal?.reason, named: refusal?.message?.includes('the refresh writer') }).toEqual({ code: 'engine_capability_missing', reason: 'raw_sql', named: true });
    expect(touched).toEqual([]);
  });

  test('runs past the check once the engine reports managed_persistence', async () => {
    const { engine, touched } = rustShaped(true);
    const refusal = await refreshWorktree(engine, 'work').then(() => null, (e: { code?: string; reason?: string; message?: string }) => e);
    expect(refusal?.code === 'engine_capability_missing' && refusal.reason === 'raw_sql').toBe(false);
    expect(touched.length).toBeGreaterThan(0);
  });
});
