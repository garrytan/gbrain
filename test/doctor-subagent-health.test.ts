/**
 * v0.41 Bug 2 / Eng D8 — `gbrain doctor` `subagent_health` check coverage.
 *
 * Reads the last 24h of `minion_lease_pressure_log` (populated by the
 * Bug 2 worker bypass path) and classifies pressure into ok / warn / fail
 * thresholds. The doctor check is the operator's primary forensic signal
 * for "is the lease cap too tight" — without it, the v0.41 bypass would
 * be invisible (no dead-letter, but also no operator visibility).
 *
 * Four cases pinned per the plan:
 *  1. 0 bounces → ok ("no pressure")
 *  2. 100+ bounces with subagent jobs completing → ok ("healthy backpressure")
 *  3. 100+ bounces with NO subagent jobs completing → warn (paste-ready hint)
 *  4. 1000+ bounces → fail (blocking)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { checkSubagentHealth } from '../src/commands/doctor.ts';
import { logLeasePressure } from '../src/core/minions/lease-pressure-audit.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_lease_pressure_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

/** Wrapper for terse test bodies. */
async function getSubagentHealthCheck() {
  return checkSubagentHealth(engine);
}

describe('doctor subagent_health (v0.41 Bug 2 / Eng D8)', () => {
  test('0 bounces → ok ("no pressure")', async () => {
    const check = await getSubagentHealthCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No rate-lease pressure');
  });

  test('healthy backpressure (1-99 bounces with completed jobs) → ok', async () => {
    // 5 bounces + 3 completed subagent jobs in the last hour.
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    for (let i = 0; i < 5; i++) {
      await logLeasePressure(engine, {
        job_id: owner.id,
        lease_key: 'anthropic:messages',
        active_at_bounce: 8,
        max_concurrent: 8,
      });
    }
    // Insert 3 completed subagent jobs.
    for (let i = 0; i < 3; i++) {
      await engine.executeRaw(
        `INSERT INTO minion_jobs
           (name, queue, status, attempts_made, attempts_started,
            finished_at, started_at, max_attempts)
         VALUES ('subagent', 'default', 'completed', 1, 1,
                 now(), now() - interval '1 second', 3)`,
      );
    }

    const check = await getSubagentHealthCheck();
    expect(check.status).toBe('ok');
    expect(check.message).toContain('bounces');
    // Sub-100 bounces routes through the second-tier OK message
    // (not the "no pressure" message; falls into "healthy backpressure").
    expect(check.message).not.toContain('No rate-lease pressure');
  });

  test('100+ bounces with NO completed subagent jobs → warn with paste-ready hint', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    for (let i = 0; i < 100; i++) {
      await logLeasePressure(engine, {
        job_id: owner.id,
        lease_key: 'anthropic:messages',
        active_at_bounce: 8,
        max_concurrent: 8,
      });
    }
    // NO completed subagent jobs — pressure is BLOCKING real work.

    const check = await getSubagentHealthCheck();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('100');
    // Paste-ready hint with the canonical env-var name.
    expect(check.message).toContain('GBRAIN_ANTHROPIC_MAX_INFLIGHT');
  });

  test('1000+ bounces → fail (blocking real work)', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    // Batch insert via VALUES rather than per-row logLeasePressure (faster).
    const valuesList: string[] = [];
    const params: Array<string | number> = [];
    for (let i = 0; i < 1000; i++) {
      valuesList.push(`($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4})`);
      params.push(owner.id, 'anthropic:messages', 8, 8);
    }
    await engine.executeRaw(
      `INSERT INTO minion_lease_pressure_log
         (job_id, lease_key, active_at_bounce, max_concurrent)
       VALUES ${valuesList.join(', ')}`,
      params,
    );

    const check = await getSubagentHealthCheck();
    expect(check.status).toBe('fail');
    expect(check.message).toContain('1000');
    expect(check.message).toContain('blocking real work');
    expect(check.message).toContain('GBRAIN_ANTHROPIC_MAX_INFLIGHT');
  });
});
