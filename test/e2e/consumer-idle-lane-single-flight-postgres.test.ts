/**
 * #6352 residual (fix wave 15 P4.6): `acquireIdleLane` had no single-flight guard. Two concurrent first callers (the
 * idle probe and a single write's `forPublication` acquisition) both reserved a connection; only the last assignment to
 * `idleLane` was tracked, and the other reservation waited on a resolver nobody held, so a reserved connection and its
 * long-hold permit leaked until process exit. The consumer now keeps the one reservation in flight and later callers
 * join it; a caller that aborts falls back to a pooled probe while the lane stays tracked; stop() and an acquisition
 * failure leave no reservation behind. Postgres only (the lane exists only there); PgBouncer CI runs the same file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import type { ReservedConnection } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-idle-lane-'));
let engine: PostgresEngine;
let close: (() => Promise<void>) | undefined;

type LaneSeam = { acquireIdleLane(signal?: AbortSignal, forPublication?: boolean): Promise<ReservedConnection | undefined>; idleLane: unknown; idleLanePending: unknown };
const reserved = () => engine.getPoolDiagnostics()!.tracked.reserved;
const consumer = () => new PersistenceConsumer(engine, { engine: 'postgres' }, async () => { throw new Error('no preparation in this test'); }, { hostId: randomUUID() });

describe.skipIf(!hasDatabase())('acquireIdleLane single flight (#6352 residual)', () => {
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
    engine = pg.engine; close = pg.close;
  }, 120_000);
  afterAll(async () => { await close?.(); rmSync(home, { recursive: true, force: true }); });

  test('two concurrent first callers (probe and publication) share one reservation; stop() releases it', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const c = consumer();
    const seam = c as unknown as LaneSeam;
    expect(reserved()).toBe(0);
    const [probe, publication] = await Promise.all([seam.acquireIdleLane(undefined, false), seam.acquireIdleLane(undefined, true)]);
    expect(probe).toBeDefined();
    expect(publication).toBe(probe);
    expect(reserved()).toBe(1);
    expect(seam.idleLanePending).toBeUndefined();
    // A later caller gets the tracked lane without a new reservation.
    expect(await seam.acquireIdleLane()).toBe(probe);
    expect(reserved()).toBe(1);
    await c.stop();
    expect(reserved()).toBe(0);
    expect(seam.idleLane).toBeUndefined();
  }), 60_000);

  test('a caller that aborts while the reservation is in flight falls back, the lane stays tracked for the next caller, and stop() releases it', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const c = consumer();
    const seam = c as unknown as LaneSeam;
    const abort = new AbortController();
    const first = seam.acquireIdleLane(abort.signal, false);
    abort.abort();
    expect(await first).toBeUndefined();
    const next = await seam.acquireIdleLane();
    expect(next).toBeDefined();
    expect(reserved()).toBe(1);
    await c.stop();
    expect(reserved()).toBe(0);
  }), 60_000);

  test('stop() during an in-flight reservation releases the connection the moment it arrives', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const c = consumer();
    const seam = c as unknown as LaneSeam;
    const pending = seam.acquireIdleLane(undefined, false);
    const stopped = c.stop();
    await Promise.all([pending, stopped]);
    expect(reserved()).toBe(0);
    expect(seam.idleLane).toBeUndefined();
    expect(seam.idleLanePending).toBeUndefined();
  }), 60_000);

  test('an acquisition failure leaves no reservation, no pending flight, and backs the lane off for a minute', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const c = consumer();
    const seam = c as unknown as LaneSeam & { idleLaneRetryAt: number };
    const real = engine.withReservedConnection.bind(engine);
    (engine as { withReservedConnection: unknown }).withReservedConnection = async () => { throw new Error('synthetic reservation failure'); };
    try {
      const [a, b] = await Promise.all([seam.acquireIdleLane(undefined, false), seam.acquireIdleLane(undefined, true)]);
      expect([a, b]).toEqual([undefined, undefined]);
    } finally { (engine as { withReservedConnection: unknown }).withReservedConnection = real; }
    expect(reserved()).toBe(0);
    expect(seam.idleLanePending).toBeUndefined();
    expect(seam.idleLaneRetryAt).toBeGreaterThan(Date.now() + 50_000);
    expect(await seam.acquireIdleLane()).toBeUndefined();
    await c.stop();
    expect(reserved()).toBe(0);
  }), 60_000);
});
