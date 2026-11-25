/**
 * The refresh store (engine-sql/refresh-store.ts) on a Rust engine whose managed_persistence hold is kept.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the refresh writer (persistence/worktree-refresh.ts `refreshWorktree`, behind `gbrain sources refresh`) now runs
 *    on the Rust store, and the store members that replaced its raw statements (`refreshStore`, `groupPublishStore`) refuse
 *    exactly as the `executeRaw` they replaced did while the hold is on: `engine_capability_missing`, reason `raw_sql`,
 *    naming `executeRaw`. With the hold lifted on that engine instance (test/engine-parity/rust-managed.ts), they answer.
 *  - Regression: lifting the refresh writer's raw-SQL stop without keeping the user-facing hold would let a user's Rust brain
 *    run a managed refresh that the held `managed_persistence` capability forbids.
 *  - Why existing coverage misses it: the parity files lift the hold on their own engine, and the refresh tests run on PGLite
 *    and Postgres, which serve raw SQL.
 *  - Seam: the store member's `heldStore` wrapper on an engine object that carries only a capability set.
 */
import { describe, expect, test } from 'bun:test';
import { heldStore } from '../src/core/rust-engine/store-members/managed-hold.ts';

const store = { readActive: async (id: string) => ({ id }), settings: async () => undefined };

describe('the refresh store on a Rust engine with the hold kept', () => {
  test('refuses every call as executeRaw refused it, naming raw_sql', async () => {
    const held = heldStore({ capabilities: new Set(['transactions', 'persistence_journal']) }, store);
    const refusal = await held.readActive('x').then(() => null, (e: { code?: string; message?: string }) => e);
    expect({ code: refusal?.code, named: refusal?.message?.includes('executeRaw') }).toEqual({ code: 'engine_capability_missing', named: true });
    await expect(held.settings()).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });

  test('answers once the engine reports managed_persistence', async () => {
    const served = heldStore({ capabilities: new Set(['managed_persistence']) }, store);
    expect(await served.readActive('x')).toEqual({ id: 'x' });
  });
});
