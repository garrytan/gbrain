/**
 * A Rust engine has no raw SQL and refuses with `engine_capability_missing`. The lock helpers must let that refusal
 * out: `tryAcquireDbLock`'s takeover step is best-effort for ordinary errors (a failed inspect means "busy"), but an
 * engine that cannot serve the lock at all must not look like a lock that is merely held.
 *
 * Real PGLite engine, wrapped so one typed lock method refuses; the refusal is shaped both ways the engines throw it
 * (`err.code`, and `err.envelope.code`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { tryAcquireDbLock, withRefreshingLock } from '../src/core/db-lock.ts';
import { isEngineCapabilityRefusal, rethrowCapabilityRefusal } from '../src/core/engine-capability-refusal.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-refusal-%'`);
});

const refusalByCode = () => Object.assign(new Error('engine_capability_missing: raw_sql'), { code: 'engine_capability_missing' });
const refusalByEnvelope = () => Object.assign(new Error('refused'), { envelope: { code: 'engine_capability_missing', reason: 'raw_sql' } });
const ordinaryFailure = () => Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });

/** The real engine with the named lock methods replaced; everything else falls through. */
function engineWith(overrides: Partial<Pick<BrainEngine, 'acquireCycleLock' | 'readCycleLocks' | 'deleteCycleLock' | 'refreshCycleLock'>>): BrainEngine {
  return new Proxy(engine as BrainEngine, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return (overrides as Record<string, unknown>)[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('isEngineCapabilityRefusal / rethrowCapabilityRefusal', () => {
  test('recognises both error shapes and nothing else', () => {
    expect(isEngineCapabilityRefusal(refusalByCode())).toBe(true);
    expect(isEngineCapabilityRefusal(refusalByEnvelope())).toBe(true);
    expect(isEngineCapabilityRefusal(ordinaryFailure())).toBe(false);
    expect(isEngineCapabilityRefusal(undefined)).toBe(false);
    expect(isEngineCapabilityRefusal(null)).toBe(false);
    expect(isEngineCapabilityRefusal('engine_capability_missing')).toBe(false);
  });

  test('rethrows a refusal and returns for any other error', () => {
    const refusal = refusalByCode();
    expect(() => rethrowCapabilityRefusal(refusal)).toThrow(refusal);
    expect(() => rethrowCapabilityRefusal(refusalByEnvelope())).toThrow('refused');
    expect(rethrowCapabilityRefusal(ordinaryFailure())).toBeUndefined();
  });
});

describe('tryAcquireDbLock and capability refusals', () => {
  for (const [shape, make] of [['code', refusalByCode], ['envelope', refusalByEnvelope]] as const) {
    test(`a refusal from acquireCycleLock (${shape}) propagates`, async () => {
      const refusing = engineWith({ acquireCycleLock: async () => { throw make(); } });
      await expect(tryAcquireDbLock(refusing, 'test-refusal-acquire')).rejects.toMatchObject({ message: expect.stringMatching(/refused|engine_capability_missing/) });
    });

    test(`a refusal while the takeover step reads the holder (${shape}) propagates`, async () => {
      // Held by a live holder, so the first acquire returns null and the takeover step inspects the row.
      const holder = await tryAcquireDbLock(engine, 'test-refusal-held');
      expect(holder).not.toBeNull();
      const refusing = engineWith({ readCycleLocks: async () => { throw make(); } });
      await expect(tryAcquireDbLock(refusing, 'test-refusal-held')).rejects.toMatchObject({ message: expect.stringMatching(/refused|engine_capability_missing/) });
      await holder!.release();
    });

    test(`withRefreshingLock surfaces the refusal (${shape}) instead of reporting a busy lock`, async () => {
      const refusing = engineWith({ acquireCycleLock: async () => { throw make(); } });
      let ran = false;
      await expect(withRefreshingLock(refusing, 'test-refusal-wrl', async () => { ran = true; })).rejects.toBeDefined();
      expect(ran).toBe(false);
    });
  }

  test('an ordinary failure while the takeover step reads the holder is still best-effort: the lock reports busy', async () => {
    const holder = await tryAcquireDbLock(engine, 'test-refusal-busy');
    expect(holder).not.toBeNull();
    const flaky = engineWith({ readCycleLocks: async () => { throw ordinaryFailure(); } });
    expect(await tryAcquireDbLock(flaky, 'test-refusal-busy')).toBeNull();
    await holder!.release();
  });
});
