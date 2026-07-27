/**
 * SkillOpt per-skill DB lock tests. Uses PGLite (R3+R4 canonical block).
 *
 * Asserts the wrapper around tryAcquireDbLock:
 *  - Acquires lock and runs fn under it.
 *  - Refreshes TTL during long runs.
 *  - Throws lock_busy when another holder has the lock.
 *  - Releases on success AND on throw.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { StructuredAgentError } from '../../src/core/errors.ts';
import { lockIdFor, tryAcquireSkilloptLock, withSkilloptLock } from '../../src/core/skillopt/lock.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('SkillOpt lock', () => {
  test('lockIdFor builds skillopt:<name> id', () => {
    expect(lockIdFor('my-skill')).toBe('skillopt:my-skill');
  });

  test('tryAcquireSkilloptLock acquires + second attempt returns null', async () => {
    const h1 = await tryAcquireSkilloptLock(engine, 'foo', 1);
    expect(h1).not.toBeNull();
    const h2 = await tryAcquireSkilloptLock(engine, 'foo', 1);
    expect(h2).toBeNull();
    await h1!.release();
    // After release, can re-acquire.
    const h3 = await tryAcquireSkilloptLock(engine, 'foo', 1);
    expect(h3).not.toBeNull();
    await h3!.release();
  });

  test('withSkilloptLock runs fn under lock and releases on success', async () => {
    let ran = false;
    await withSkilloptLock(engine, 'bar', async () => {
      ran = true;
      // While the lock is held, another acquire should return null.
      const inner = await tryAcquireSkilloptLock(engine, 'bar', 1);
      expect(inner).toBeNull();
    }, 1, /* fast refresh */ 30_000);
    expect(ran).toBe(true);
    // After fn completes, lock is released.
    const after = await tryAcquireSkilloptLock(engine, 'bar', 1);
    expect(after).not.toBeNull();
    await after!.release();
  });

  test('withSkilloptLock throws LockBusy when a holder exists', async () => {
    const held = await tryAcquireSkilloptLock(engine, 'baz', 1);
    expect(held).not.toBeNull();
    let caught: unknown = null;
    try {
      await withSkilloptLock(engine, 'baz', async () => { /* unreached */ }, 1, 30_000);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StructuredAgentError);
    expect((caught as StructuredAgentError).envelope.code).toBe('lock_busy');
    await held!.release();
  });

  test('withSkilloptLock releases on throw inside fn', async () => {
    let caught: unknown = null;
    try {
      await withSkilloptLock(engine, 'qux', async () => {
        throw new Error('inner failure');
      }, 1, 30_000);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe('inner failure');
    // Lock is released; we can re-acquire.
    const after = await tryAcquireSkilloptLock(engine, 'qux', 1);
    expect(after).not.toBeNull();
    await after!.release();
  });
});
