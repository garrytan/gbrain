/**
 * issue #6 — CheckoutGauge (pure) + the PostgresEngine gauge seams.
 *
 * The leak guard matters most: a counter that isn't released on a THROWING
 * query drifts upward forever and turns the diagnostics into fiction. The
 * engine seams use the Object.create(PostgresEngine.prototype) + fake-pool
 * pattern (no real DB).
 */

import { describe, expect, test } from 'bun:test';
import { CheckoutGauge } from '../src/core/pool-gauge.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

describe('CheckoutGauge (pure)', () => {
  test('acquire/release round-trip per kind', () => {
    const g = new CheckoutGauge();
    g.acquire('raw');
    g.acquire('raw');
    g.acquire('direct');
    g.acquire('reserved');
    g.acquire('tx');
    expect(g.snapshot()).toEqual({ raw: 2, direct: 1, reserved: 1, tx: 1 });
    g.release('raw');
    g.release('direct');
    g.release('reserved');
    g.release('tx');
    expect(g.snapshot()).toEqual({ raw: 1, direct: 0, reserved: 0, tx: 0 });
  });

  test('release clamps at zero (a missed acquire never underflows)', () => {
    const g = new CheckoutGauge();
    g.release('raw');
    g.release('tx');
    expect(g.snapshot()).toEqual({ raw: 0, direct: 0, reserved: 0, tx: 0 });
  });

  test('snapshot is a copy, not a live reference', () => {
    const g = new CheckoutGauge();
    const snap = g.snapshot();
    g.acquire('raw');
    expect(snap.raw).toBe(0);
  });
});

// --- engine seams (fake pool, no DB) ---------------------------------------

interface FakePoolBehavior {
  /** What conn.unsafe returns per call. */
  unsafe: (sql: string, params?: unknown[]) => unknown;
}

function makeEngine(behavior: FakePoolBehavior): {
  engine: PostgresEngine;
  diagnostics: () => { tracked: Record<string, number>; poolMax: number | null } | null;
} {
  const fakePool = {
    unsafe: behavior.unsafe,
    options: { max: 10 },
  };
  const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
  Object.defineProperty(engine, 'sql', { get: () => fakePool });
  Object.defineProperty(engine, '_sql', { value: fakePool, writable: true });
  // Fresh gauge per fake engine (the real field initializer doesn't run for
  // Object.create instances).
  Object.defineProperty(engine, 'checkoutGauge', {
    value: new CheckoutGauge(),
    writable: true,
  });
  return {
    engine,
    diagnostics: () =>
      (engine as unknown as {
        getPoolDiagnostics: () => { tracked: Record<string, number>; poolMax: number | null } | null;
      }).getPoolDiagnostics(),
  };
}

describe('PostgresEngine gauge seams (fake pool)', () => {
  test('executeRaw: counted while in flight, released on resolve', async () => {
    let resolveQuery: (rows: unknown[]) => void = () => {};
    const { engine, diagnostics } = makeEngine({
      unsafe: () => new Promise((r) => { resolveQuery = r; }),
    });

    const p = engine.executeRaw('SELECT 42');
    expect(diagnostics()?.tracked.raw).toBe(1);
    expect(diagnostics()?.poolMax).toBe(10);
    resolveQuery([]);
    await p;
    expect(diagnostics()?.tracked.raw).toBe(0);
  });

  test('executeRaw: released on REJECTED query (leak guard)', async () => {
    const { engine, diagnostics } = makeEngine({
      unsafe: () => Promise.reject(new Error('query was cancelled')),
    });
    await expect(engine.executeRaw('SELECT 42')).rejects.toThrow('query was cancelled');
    expect(diagnostics()?.tracked.raw).toBe(0);
  });

  test('executeRaw: released on SYNCHRONOUS throw (pre-aborted signal)', async () => {
    const { engine, diagnostics } = makeEngine({
      unsafe: () => Promise.resolve([]),
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      engine.executeRaw('SELECT 42', undefined, { signal: ac.signal }),
    ).rejects.toThrow();
    expect(diagnostics()?.tracked.raw).toBe(0);
  });

  test('getPoolDiagnostics is fail-open (no pool → null, no throw)', () => {
    const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
    // No sql defined — the getter on the prototype will throw internally.
    const diag = (engine as unknown as {
      getPoolDiagnostics: () => unknown;
    }).getPoolDiagnostics();
    expect(diag).toBeNull();
  });
});

describe('PostgresEngine gauge seams: direct + tx (coverage-audit gaps)', () => {
  test('executeRawDirect: counted as direct while in flight, released on resolve and reject', async () => {
    let resolveQuery: (rows: unknown[]) => void = () => {};
    const { engine, diagnostics } = makeEngine({
      unsafe: () => new Promise((r) => { resolveQuery = r; }),
    });
    // No connectionManager on the fake -> executeRawDirect falls through to this.sql.
    const p = engine.executeRawDirect('SELECT 1');
    expect(diagnostics()?.tracked.direct).toBe(1);
    resolveQuery([]);
    await p;
    expect(diagnostics()?.tracked.direct).toBe(0);

    const { engine: rejEngine, diagnostics: rejDiag } = makeEngine({
      unsafe: () => Promise.reject(new Error('boom')),
    });
    await expect(rejEngine.executeRawDirect('SELECT 1')).rejects.toThrow('boom');
    expect(rejDiag()?.tracked.direct).toBe(0);
  });

  test('transaction: tx counter released on SYNCHRONOUS begin() throw (nested-tx clone class)', async () => {
    const { engine, diagnostics } = makeEngine({ unsafe: () => Promise.resolve([]) });
    // Fake pool has no .begin -> conn.begin(...) throws synchronously, the
    // exact shape a nested transaction on a tx clone produces.
    await expect(
      (engine as unknown as { transaction: (fn: unknown) => Promise<unknown> }).transaction(async () => 'x'),
    ).rejects.toThrow();
    expect(diagnostics()?.tracked.tx).toBe(0);
  });

  test('withReservedConnection: ddl() throw falls back to the READ pool and releases the permit', async () => {
    const log: string[] = [];
    const readPool = {
      unsafe: async () => [],
      options: { max: 10 },
      reserve: async () => {
        log.push('reserve:read');
        return { unsafe: async () => [], release: () => log.push('release:read') };
      },
    };
    const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
    Object.defineProperty(engine, 'sql', { get: () => readPool });
    Object.defineProperty(engine, '_sql', { value: readPool, writable: true });
    Object.defineProperty(engine, 'checkoutGauge', { value: new CheckoutGauge(), writable: true });
    Object.defineProperty(engine, '_reservedDirectInFlight', { value: 0, writable: true });
    Object.defineProperty(engine, 'connectionManager', {
      value: {
        peekReadPool: () => readPool,
        isDualPoolActive: () => true,
        describeMode: () => ({ direct_pool_size: 3 }),
        ddl: async () => { throw new Error('EMAXCONNSESSION'); },
      },
      writable: true,
    });
    const out = await engine.withReservedConnection(async () => 'ok');
    expect(out).toBe('ok');
    expect(log).toEqual(['reserve:read', 'release:read']); // fell back, did not fail the caller
    expect((engine as unknown as { _reservedDirectInFlight: number })._reservedDirectInFlight).toBe(0);
  });
});
