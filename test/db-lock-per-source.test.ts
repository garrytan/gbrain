/**
 * v0.40 Federated Sync v2 — per-source lock contract.
 *
 * Pins the iron-rule regression for the SYNC_LOCK_ID rename:
 *   - SYNC_LOCK_ID === syncLockId('default')  (back-compat alias)
 *   - syncLockId(X) !== syncLockId(Y) for X !== Y  (per-source isolation)
 *   - two concurrent tryAcquireDbLock calls against DIFFERENT sources both succeed
 *   - two concurrent tryAcquireDbLock calls against the SAME source: second returns null
 *
 * Without this guard, a future drift in the constant value would silently change
 * semantics (e.g. someone hardcoding 'gbrain-sync' elsewhere would no longer match
 * the same row, breaking the writer-window exclusion that performSync relies on).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { syncLockId, SYNC_LOCK_ID, tryAcquireDbLock } from '../src/core/db-lock.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('syncLockId (per-source lock helper)', () => {
  test('default source returns gbrain-sync:default', () => {
    expect(syncLockId('default')).toBe('gbrain-sync:default');
  });

  test('non-default source returns gbrain-sync:<id>', () => {
    expect(syncLockId('zion-brain')).toBe('gbrain-sync:zion-brain');
    expect(syncLockId('media-corpus')).toBe('gbrain-sync:media-corpus');
  });

  test('IRON-RULE: SYNC_LOCK_ID back-compat alias resolves to syncLockId(default)', () => {
    expect(SYNC_LOCK_ID).toBe(syncLockId('default'));
    expect(SYNC_LOCK_ID).toBe('gbrain-sync:default');
  });

  test('different sources produce distinct lock keys', () => {
    expect(syncLockId('a')).not.toBe(syncLockId('b'));
  });
});

describe('tryAcquireDbLock with per-source keys', () => {
  test('two locks against different sources both succeed', async () => {
    const lockA = await tryAcquireDbLock(engine, syncLockId('source-a'));
    const lockB = await tryAcquireDbLock(engine, syncLockId('source-b'));
    expect(lockA).not.toBeNull();
    expect(lockB).not.toBeNull();
    await lockA?.release();
    await lockB?.release();
  });

  test('second lock against the same source returns null while first is held', async () => {
    const first = await tryAcquireDbLock(engine, syncLockId('source-c'));
    expect(first).not.toBeNull();
    const second = await tryAcquireDbLock(engine, syncLockId('source-c'));
    expect(second).toBeNull();
    await first?.release();
    // After release, third acquire succeeds.
    const third = await tryAcquireDbLock(engine, syncLockId('source-c'));
    expect(third).not.toBeNull();
    await third?.release();
  });

  test('SYNC_LOCK_ID and syncLockId(default) acquire the SAME lock row', async () => {
    // This is the critical back-compat check: pre-v0.40 callers using SYNC_LOCK_ID
    // and new callers using syncLockId('default') MUST conflict (not bypass each other).
    const first = await tryAcquireDbLock(engine, SYNC_LOCK_ID);
    expect(first).not.toBeNull();
    const second = await tryAcquireDbLock(engine, syncLockId('default'));
    expect(second).toBeNull();
    await first?.release();
  });
});
