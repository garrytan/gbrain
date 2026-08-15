/**
 * v0.41 E2E IRON-RULE — Eng D6 controller sign correction.
 *
 * Pins the load-bearing post-codex-pass-2-#9 correction at the
 * integration boundary: bounces without 429s = workers starving = cap
 * goes UP, NOT down. Pre-correction, the controller would crater the
 * cap during a healthy 100-job burst (the field-report scenario).
 *
 * This test simulates 100 bounce events in the audit table (no real
 * worker pressure needed — just write rows) and runs the controller
 * tick. Asserts cap moved UP.
 *
 * REGRESSION GUARD — if a future "simplify the controller rule" PR ever
 * inverts this sign, this test screams.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { controllerTick, writeLeaseCap, readCurrentLeaseCap } from '../../src/core/minions/lease-cap-controller.ts';
import { logLeasePressure } from '../../src/core/minions/lease-pressure-audit.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_lease_pressure_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = 'minions-lease-cap-controller'`);
  await engine.executeRaw(`DELETE FROM config WHERE key = 'minions.lease_cap_current'`);
}, 30_000);

describe('v0.41 lease-cap controller E2E (Eng D6 corrected sign)', () => {
  test('IRON-RULE: bounces without 429s ramp cap UP (not DOWN)', async () => {
    await writeLeaseCap(engine, 8); // start with the legacy default
    // Seed an owner job (not strictly required, but matches realistic state).
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    // Simulate 100 bounce events in the audit table. No 429s. No completed
    // subagent jobs (so the bounce-rate signal dominates).
    for (let i = 0; i < 100; i++) {
      await logLeasePressure(engine, {
        job_id: owner.id,
        lease_key: 'anthropic:messages',
        active_at_bounce: 8,
        max_concurrent: 8,
      });
    }

    // Run the controller tick.
    const r = await controllerTick(engine);
    expect(r).not.toBeNull();
    expect(r!.changed).toBe(true);
    // CRITICAL: cap MUST have gone UP. The pre-correction draft would
    // have done r!.next < 8 here.
    expect(r!.next).toBeGreaterThan(8);

    const stored = await readCurrentLeaseCap(engine);
    expect(stored).toBeGreaterThan(8);
  });

  test('upstream 429s ramp cap DOWN even with bounces present', async () => {
    await writeLeaseCap(engine, 64);
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    // Bounces + REAL upstream rate-limit failures.
    for (let i = 0; i < 50; i++) {
      await logLeasePressure(engine, {
        job_id: owner.id,
        lease_key: 'anthropic:messages',
        active_at_bounce: 64,
        max_concurrent: 64,
      });
    }
    // Insert dead jobs whose error_text matches the 429 classifier path.
    for (let i = 0; i < 10; i++) {
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, attempts_made, attempts_started, max_attempts, error_text, finished_at)
         VALUES ('subagent-test', 'default', 'failed', 1, 1, 1, '429 Too Many Requests', now())`,
      );
    }

    const r = await controllerTick(engine);
    expect(r).not.toBeNull();
    expect(r!.changed).toBe(true);
    // Upstream 429s = cap must go DOWN.
    expect(r!.next).toBeLessThan(64);
  });
});
