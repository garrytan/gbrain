/**
 * Adversarial: two concurrent SkillOpt invocations against the SAME skill.
 *
 * Without the D14 per-skill DB lock, both would race on `version_n`,
 * `history.json`, and SKILL.md. The lock ensures the second invocation
 * gets a clean LockBusy error with a paste-ready hint.
 *
 * .serial.test.ts because it uses PGLite (R3+R4 canonical block) and
 * the test sequences two concurrent acquire attempts.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../../helpers/reset-pglite.ts';
import { StructuredAgentError } from '../../../src/core/errors.ts';
import {
  tryAcquireSkilloptLock,
  withSkilloptLock,
} from '../../../src/core/skillopt/lock.ts';

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

describe('adversarial: concurrent SkillOpt runs', () => {
  test('second concurrent run sees LockBusy with paste-ready hint', async () => {
    const a = await tryAcquireSkilloptLock(engine, 'race-target', 1);
    expect(a).not.toBeNull();

    let caught: unknown = null;
    try {
      await withSkilloptLock(engine, 'race-target', async () => {
        throw new Error('should not run — lock is held');
      }, 1, 60_000);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StructuredAgentError);
    expect((caught as StructuredAgentError).envelope.code).toBe('lock_busy');
    // Hint must mention how to recover.
    expect((caught as StructuredAgentError).envelope.hint).toMatch(/wait|status/i);

    await a!.release();
  });

  test('three back-to-back races serialize cleanly', async () => {
    // Acquire, release, acquire, release, acquire — should never throw.
    for (let i = 0; i < 3; i++) {
      const handle = await tryAcquireSkilloptLock(engine, 'serial-race', 1);
      expect(handle).not.toBeNull();
      await handle!.release();
    }
  });

  test('different skill names do NOT block each other', async () => {
    const a = await tryAcquireSkilloptLock(engine, 'skill-a', 1);
    const b = await tryAcquireSkilloptLock(engine, 'skill-b', 1);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  test('withSkilloptLock releases on success path so a later run can acquire', async () => {
    let counter = 0;
    await withSkilloptLock(engine, 'release-after-success', async () => {
      counter += 1;
    }, 1, 60_000);
    expect(counter).toBe(1);
    // Now acquire freshly.
    const after = await tryAcquireSkilloptLock(engine, 'release-after-success', 1);
    expect(after).not.toBeNull();
    await after!.release();
  });

  test('withSkilloptLock releases on throw path so retries work', async () => {
    let caught: unknown = null;
    try {
      await withSkilloptLock(engine, 'release-after-throw', async () => {
        throw new Error('inner failure for test');
      }, 1, 60_000);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe('inner failure for test');
    const after = await tryAcquireSkilloptLock(engine, 'release-after-throw', 1);
    expect(after).not.toBeNull();
    await after!.release();
  });
});
