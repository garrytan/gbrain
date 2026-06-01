import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * #1570 regression: the db.ts module singleton (`sql`) is shared by every
 * module-style engine in the process. Before the refcount, a transient
 * engine's disconnect() called `sql.end()` + nulled the singleton while a
 * long-lived owner (the `gbrain dream` cycle engine) was still using it,
 * causing sync/synthesize to throw "connect() has not been called" mid-cycle.
 *
 * The fix refcounts owners: connect() increments, disconnect() decrements,
 * and the pool is only torn down when the LAST owner releases it.
 *
 * We mock `postgres` so connect()/disconnect() run without a live database —
 * matching connection-resilience.test.ts's "extract the behavior, unit-test
 * it" posture.
 */

let endCalls = 0;
function makeFakeSql() {
  // Tagged-template-callable client: db.connect() does `await sql`SELECT 1``.
  const fn: any = (..._args: unknown[]) => Promise.resolve([{ ok: 1 }]);
  fn.end = async () => { endCalls++; };
  return fn;
}

mock.module('postgres', () => {
  const factory: any = (_url: string, _opts: unknown) => makeFakeSql();
  factory.BigInt = class {}; // db.ts references postgres.BigInt in the type map
  return { default: factory };
});

const CFG = { database_url: 'postgres://test/refcount' } as any;

describe('db.ts module singleton refcount (#1570)', () => {
  let db: typeof import('../src/core/db.ts');

  beforeEach(async () => {
    endCalls = 0;
    db = await import('../src/core/db.ts');
    // Drain any owners left over from a prior test so each case starts clean.
    for (let i = 0; i < 16; i++) {
      try { await db.disconnect(); } catch { /* already torn down */ }
    }
    endCalls = 0;
  });

  it('keeps the singleton alive until the LAST owner disconnects', async () => {
    await db.connect(CFG);            // fresh owner → refcount 1
    await db.connect(CFG);            // shared owner → refcount 2
    expect(() => db.getConnection()).not.toThrow();

    await db.disconnect();            // a transient owner releases → refcount 1
    expect(() => db.getConnection()).not.toThrow(); // STILL alive — the #1570 fix
    expect(endCalls).toBe(0);         // pool not torn down while an owner remains

    await db.disconnect();            // last owner releases → refcount 0
    expect(endCalls).toBe(1);         // now the pool is ended exactly once
    expect(() => db.getConnection()).toThrow(/connect\(\) has not been called/);
  });

  it('a single connect/disconnect pair tears down exactly once', async () => {
    await db.connect(CFG);
    expect(() => db.getConnection()).not.toThrow();
    await db.disconnect();
    expect(endCalls).toBe(1);
    expect(() => db.getConnection()).toThrow();
  });
});
