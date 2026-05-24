/**
 * v0.41 Eng D9 — tryWithDbElection convenience tests.
 *
 * Verifies the per-tick election shape against PGLite:
 *   - First call wins → fn runs → returns its value
 *   - Concurrent second call gets null (someone else holds the lock)
 *   - After first releases, next caller wins
 *   - fn throws → lock released cleanly, error propagates
 *   - Different lock IDs are independent
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryWithDbElection, tryAcquireDbLock } from '../src/core/db-lock.ts';

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
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-election-%'`);
});

describe('tryWithDbElection', () => {
  test('first caller wins → fn runs → returns its value', async () => {
    const result = await tryWithDbElection(engine, 'test-election-1', 1, async () => 'won');
    expect(result).toBe('won');
  });

  test('lock auto-released after fn returns', async () => {
    // First call acquires + releases.
    await tryWithDbElection(engine, 'test-election-2', 1, async () => 'first');
    // Second call should win because the first released.
    const r = await tryWithDbElection(engine, 'test-election-2', 1, async () => 'second');
    expect(r).toBe('second');
  });

  test('concurrent acquire by a different holder returns null (not my tick)', async () => {
    // Manually acquire the lock so tryWithDbElection finds it held.
    const handle = await tryAcquireDbLock(engine, 'test-election-3', 1);
    expect(handle).not.toBeNull();
    try {
      let ran = false;
      const r = await tryWithDbElection(engine, 'test-election-3', 1, async () => {
        ran = true;
        return 'should not run';
      });
      expect(r).toBeNull();
      expect(ran).toBe(false);
    } finally {
      await handle!.release();
    }
  });

  test('fn throw releases the lock cleanly + rethrows', async () => {
    await expect(
      tryWithDbElection(engine, 'test-election-4', 1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Lock was released — next caller can acquire.
    const r = await tryWithDbElection(engine, 'test-election-4', 1, async () => 'ok');
    expect(r).toBe('ok');
  });

  test('different lock IDs are independent', async () => {
    const a = await tryAcquireDbLock(engine, 'test-election-A', 1);
    expect(a).not.toBeNull();
    try {
      // Different id should not conflict.
      const r = await tryWithDbElection(engine, 'test-election-B', 1, async () => 'B-won');
      expect(r).toBe('B-won');
    } finally {
      await a!.release();
    }
  });
});
