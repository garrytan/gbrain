/**
 * Lock host identity (`GBRAIN_LOCK_HOST`). The dead-holder reaper compares
 * the lock row's holder_host with the local host and, on a match, probes
 * the holder PID. Hosts whose hostname is not unique per process space
 * break that: every Modal container reports hostname `modal` and runs its
 * worker as PID 2, so a live holder in another container looked like a dead
 * local process and was reaped after HOLDER_TAKEOVER_GRACE_MS (the
 * `lock_stolen` cycle reports of 2026-08 and the aborted first dream on
 * 2026-09-02). With a per-container identity every other container is
 * `cross_host` and only the TTL plus steal grace can take a lock over.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hostname } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  classifyHolderLiveness, lockHostIdentity, reapDeadHolderLocks, tryAcquireDbLock, inspectLock,
  HOLDER_TAKEOVER_GRACE_MS,
} from '../src/core/db-lock.ts';

const deadPid = (_pid: number, _sig: number) => { const e: NodeJS.ErrnoException = new Error('no such process'); e.code = 'ESRCH'; throw e; };

describe('lockHostIdentity', () => {
  test('defaults to os.hostname()', async () => {
    await withEnv({ GBRAIN_LOCK_HOST: undefined }, async () => {
      expect(lockHostIdentity()).toBe(hostname());
    });
  });
  test('GBRAIN_LOCK_HOST overrides it; blank falls back', async () => {
    await withEnv({ GBRAIN_LOCK_HOST: 'modal:ta-01ABC' }, async () => {
      expect(lockHostIdentity()).toBe('modal:ta-01ABC');
    });
    await withEnv({ GBRAIN_LOCK_HOST: '   ' }, async () => {
      expect(lockHostIdentity()).toBe(hostname());
    });
  });
});

describe('classifyHolderLiveness across containers', () => {
  const old = HOLDER_TAKEOVER_GRACE_MS * 10;
  test('the Modal failure: same hostname, dead PID, old enough → dead_eligible (what reaped the dream)', () => {
    expect(classifyHolderLiveness(2, 'modal', old, { localHost: 'modal', processKill: deadPid })).toBe('dead_eligible');
  });
  test('per-container identities: another container is cross_host even with a dead PID', () => {
    expect(classifyHolderLiveness(2, 'modal:ta-A', old, { localHost: 'modal:ta-B', processKill: deadPid })).toBe('cross_host');
  });
  test('the local container still reaps its own dead holder', () => {
    expect(classifyHolderLiveness(2, 'modal:ta-A', old, { localHost: 'modal:ta-A', processKill: deadPid })).toBe('dead_eligible');
  });
});

describe('tryAcquireDbLock + reapDeadHolderLocks with GBRAIN_LOCK_HOST (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the lock row carries the override, and a different identity never reaps it', async () => {
    const handle = await withEnv({ GBRAIN_LOCK_HOST: 'modal:ta-A' }, () => tryAcquireDbLock(engine, 'gbrain-cycle:default', 5));
    expect(handle).not.toBeNull();
    try {
      const snap = await inspectLock(engine, 'gbrain-cycle:default');
      expect(snap?.holder_host).toBe('modal:ta-A');
      // Another container (identity B), even with a PID probe that says dead
      // and any age: cross_host, nothing reaped.
      const r = await reapDeadHolderLocks(engine, { localHost: 'modal:ta-B', processKill: deadPid });
      expect(r.reapedIds).not.toContain('gbrain-cycle:default');
      expect(await inspectLock(engine, 'gbrain-cycle:default')).not.toBeNull();
    } finally {
      await handle!.release();
    }
  });
});
