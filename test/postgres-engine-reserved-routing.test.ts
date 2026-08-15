/**
 * issue #6 — `withReservedConnection` routing:
 *
 *   dual-pool active + permit available  → reserve from the DIRECT pool
 *     (30-min statement_timeout lane; stops long DDL/backfill holds from
 *     pinning the worker's shared read pool)
 *   semaphore exhausted (directPoolSize-1 in flight) → READ pool (status quo;
 *     >= 1 direct slot always stays free for claim/renewLock heartbeats)
 *   kill-switched / single-pool          → READ pool (status quo)
 *   inside an open transaction           → never rerouted
 *   throw inside fn / reserve failure    → semaphore released (leak guard)
 *
 * Hermetic: Object.create(PostgresEngine.prototype) + recording fake pools.
 */

import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { CheckoutGauge } from '../src/core/pool-gauge.ts';

interface FakeReserved {
  unsafe: (q: string, params?: unknown[]) => Promise<unknown[]>;
  release: () => void;
}

function makeFakePool(label: string, log: string[]) {
  return {
    label,
    unsafe: async () => [],
    options: { max: 10 },
    reserve: async (): Promise<FakeReserved> => {
      log.push(`reserve:${label}`);
      return {
        unsafe: async () => [],
        release: () => log.push(`release:${label}`),
      };
    },
  };
}

function makeEngine(opts: {
  dualPool: boolean;
  directPoolSize?: number;
  inTransaction?: boolean;
  log: string[];
}) {
  const readPool = makeFakePool('read', opts.log);
  const directPool = makeFakePool('direct', opts.log);
  const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
  Object.defineProperty(engine, 'sql', { get: () => readPool });
  // inTransaction detection: _sql !== null && peekReadPool() !== _sql.
  // Simulate "in transaction" by making _sql differ from peekReadPool().
  Object.defineProperty(engine, '_sql', {
    value: opts.inTransaction ? { txMarker: true } : readPool,
    writable: true,
  });
  Object.defineProperty(engine, 'checkoutGauge', { value: new CheckoutGauge(), writable: true });
  Object.defineProperty(engine, '_reservedDirectInFlight', { value: 0, writable: true });
  Object.defineProperty(engine, 'connectionManager', {
    value: {
      peekReadPool: () => readPool,
      isDualPoolActive: () => opts.dualPool,
      describeMode: () => ({ direct_pool_size: opts.directPoolSize ?? 3 }),
      ddl: async () => directPool,
    },
    writable: true,
  });
  return engine;
}

describe('withReservedConnection routing (issue #6)', () => {
  test('dual-pool active: reserves from the DIRECT pool', async () => {
    const log: string[] = [];
    const engine = makeEngine({ dualPool: true, log });
    await engine.withReservedConnection(async () => 'ok');
    expect(log).toEqual(['reserve:direct', 'release:direct']);
  });

  test('single-pool (kill-switched): reserves from the READ pool (status quo)', async () => {
    const log: string[] = [];
    const engine = makeEngine({ dualPool: false, log });
    await engine.withReservedConnection(async () => 'ok');
    expect(log).toEqual(['reserve:read', 'release:read']);
  });

  test('inside a transaction: never rerouted', async () => {
    const log: string[] = [];
    const engine = makeEngine({ dualPool: true, inTransaction: true, log });
    await engine.withReservedConnection(async () => 'ok');
    expect(log).toEqual(['reserve:read', 'release:read']);
  });

  test('semaphore: directPoolSize-1 concurrent direct reserves; overflow -> read pool', async () => {
    const log: string[] = [];
    const engine = makeEngine({ dualPool: true, directPoolSize: 3, log });

    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const first = engine.withReservedConnection(
      () => new Promise((r) => { releaseFirst = () => r('one'); }),
    );
    const second = engine.withReservedConnection(
      () => new Promise((r) => { releaseSecond = () => r('two'); }),
    );
    // Let both reserves happen.
    await new Promise((r) => setTimeout(r, 10));
    expect(log.filter((l) => l === 'reserve:direct').length).toBe(2); // cap = 3-1 = 2

    // Third concurrent reserve overflows to the read pool (status quo, never blocks).
    const third = await engine.withReservedConnection(async () => 'three');
    expect(third).toBe('three');
    expect(log).toContain('reserve:read');

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);

    // Permits released: the next reserve goes direct again.
    log.length = 0;
    await engine.withReservedConnection(async () => 'four');
    expect(log).toEqual(['reserve:direct', 'release:direct']);
  });

  test('direct_pool_size=1: NEVER reserves from the direct pool (a reserve would starve ALL heartbeats)', async () => {
    // Red-team finding: a Math.max(1, size-1) floor made cap=1 at size=1,
    // letting a multi-minute reserve consume the ONLY direct session that
    // claim/renewLock heartbeats depend on — the #6 class reintroduced.
    const log: string[] = [];
    const engine = makeEngine({ dualPool: true, directPoolSize: 1, log });
    await engine.withReservedConnection(async () => 'ok');
    expect(log).toEqual(['reserve:read', 'release:read']);
  });

  test('fn throw releases the semaphore permit (leak guard)', async () => {
    const log: string[] = [];
    const engine = makeEngine({ dualPool: true, directPoolSize: 2, log }); // cap = 1
    await expect(
      engine.withReservedConnection(async () => { throw new Error('DDL boom'); }),
    ).rejects.toThrow('DDL boom');
    // Permit released: next reserve still goes direct (cap would block if leaked).
    log.length = 0;
    await engine.withReservedConnection(async () => 'ok');
    expect(log).toEqual(['reserve:direct', 'release:direct']);
  });

  test('reserve() failure releases the permit and rethrows', async () => {
    const log: string[] = [];
    const engine = makeEngine({ dualPool: true, directPoolSize: 2, log });
    const cm = (engine as unknown as { connectionManager: { ddl: () => Promise<unknown> } }).connectionManager;
    cm.ddl = async () => ({
      reserve: async () => { throw new Error('EMAXCONNSESSION'); },
    });
    await expect(engine.withReservedConnection(async () => 'x')).rejects.toThrow('EMAXCONNSESSION');
    // Permit released despite the failure.
    expect(
      (engine as unknown as { _reservedDirectInFlight: number })._reservedDirectInFlight,
    ).toBe(0);
  });
});
