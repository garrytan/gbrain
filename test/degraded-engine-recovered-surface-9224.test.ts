/**
 * #9224: a status-only `gbrain serve` over PGLite runs on the degraded stand-in, and once the brain opens it
 * becomes the persistence owner. Every delegated sync that had pages to write then failed with
 * "Unknown engine kind for db-lock: pglite": recovery re-aligned the stand-in's methods with the live engine
 * but not its getters or fields, so `engine.db` stayed missing and tryAcquireDbLock fell through.
 *
 * 1. Protects: after recovery the stand-in exposes exactly the live engine's surface (every key reachable on it,
 *    read through to it), enumerated from the real engine so a getter or field added later is covered, and the
 *    sync writer lock is taken on it as on the engine itself.
 * 2. Fails when: recovery leaves any property of the live engine missing, stale or different, or keeps one the
 *    live engine does not have.
 * 3. Real seams: a real PGLite engine (and a real Postgres engine when DATABASE_URL is set), the real stand-in
 *    and the real db lock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDegradedEngine, DegradedRecoveredRetryError } from '../src/core/degraded-engine.ts';
import { DEGRADED_LAST_ERROR, DEGRADED_ON_RECOVER, DEGRADED_STATE } from '../src/core/degraded-marker.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const STAND_IN_KEYS = new Set<PropertyKey>([DEGRADED_STATE, DEGRADED_ON_RECOVER, DEGRADED_LAST_ERROR]);
const LOCK_ID = 'gbrain-sync';

function reachableKeys(engine: object): PropertyKey[] {
  const keys = new Set<PropertyKey>();
  for (let holder: object | null = engine; holder && holder !== Object.prototype; holder = Object.getPrototypeOf(holder)) {
    for (const key of Reflect.ownKeys(holder)) if (key !== 'constructor') keys.add(key);
  }
  return [...keys];
}

function read(engine: object, key: PropertyKey): { value?: unknown; error?: string } {
  try { return { value: (engine as Record<PropertyKey, unknown>)[key] }; } catch (e) { return { error: (e as Error).message }; }
}

for (const kind of testBackends()) {
  describe(`degraded stand-in recovered onto a live ${kind} engine (#9224)`, () => {
    let live: BrainEngine;
    let close: () => Promise<void>;
    let engine: BrainEngine;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine: live, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { live = new PGLiteEngine(); await live.connect({ engine: 'pglite' } as never); await live.initSchema(); close = () => live.disconnect(); }
      engine = createDegradedEngine({
        initialError: new Error('This brain is open in another gbrain serve.'),
        reconnect: async () => live,
        minIntervalMs: 0,
        kind,
      });
      await expect(engine.getStats()).rejects.toBeInstanceOf(DegradedRecoveredRetryError);
    }, 120_000);

    afterAll(async () => { await close?.(); });

    test('every property reachable on the live engine reads the same through the recovered stand-in', () => {
      const keys = reachableKeys(live);
      expect(keys.length).toBeGreaterThan(50);
      const differ: string[] = [];
      for (const key of keys) {
        if (!(key in engine)) { differ.push(`${String(key)}: missing`); continue; }
        const want = read(live, key), got = read(engine, key);
        if (want.error !== undefined || got.error !== undefined) {
          if (want.error !== got.error) differ.push(`${String(key)}: threw ${got.error ?? 'nothing'}, live threw ${want.error ?? 'nothing'}`);
          continue;
        }
        if (typeof got.value !== typeof want.value) { differ.push(`${String(key)}: ${typeof got.value}, live ${typeof want.value}`); continue; }
        if (typeof want.value !== 'function' && Object.is(want.value, read(live, key).value) && !Object.is(got.value, want.value)) differ.push(`${String(key)}: a different value`);
      }
      expect(differ).toEqual([]);
    });

    test('a synchronous engine method stays synchronous through the recovered stand-in', () => {
      const asyncWrapped = reachableKeys(live).filter(key => {
        const method = read(live, key).value;
        if (typeof method !== 'function' || method.constructor.name === 'AsyncFunction') return false;
        return (read(engine, key).value as { constructor: { name: string } }).constructor.name === 'AsyncFunction';
      }).map(String);
      expect(asyncWrapped).toEqual([]);
      const unregister = engine.registerBeforeDisconnect(async () => {});
      expect(typeof unregister).toBe('function');
      unregister();
    });

    test('the stand-in keeps no property the live engine does not have', () => {
      const extra = Reflect.ownKeys(engine).filter(key => !STAND_IN_KEYS.has(key) && !(key in live)).map(String);
      expect(extra).toEqual([]);
      expect(engine.kind).toBe(kind);
    });

    test('the sync writer lock is taken, refreshed and released on the recovered engine', async () => {
      const lock = await tryAcquireDbLock(engine, LOCK_ID);
      expect(lock).not.toBeNull();
      try {
        const held = await live.executeRaw<{ holder_pid: number }>('SELECT holder_pid FROM gbrain_cycle_locks WHERE id = $1', [LOCK_ID]);
        expect(held.map(row => Number(row.holder_pid))).toEqual([process.pid]);
        expect(await lock!.refresh()).toBe(true);
      } finally {
        await lock?.release();
      }
      expect(await live.executeRaw('SELECT 1 FROM gbrain_cycle_locks WHERE id = $1', [LOCK_ID])).toEqual([]);
    });
  });
}
