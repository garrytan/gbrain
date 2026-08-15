/**
 * v0.41 E2E — jobs watch readSnapshot integration.
 *
 * Pairs with the pure-function renderer tests in
 * test/jobs-watch-snapshot.test.ts. This file verifies readSnapshot
 * correctly aggregates from the engine: stats, lease pressure, top
 * errors clustered, budget owners with cents.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { readSnapshot } from '../../src/commands/jobs-watch.ts';
import { logLeasePressure } from '../../src/core/minions/lease-pressure-audit.ts';
import { setOwnerBudget } from '../../src/core/minions/budget-tracker.ts';

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
}, 30_000);

describe('v0.41 jobs-watch readSnapshot E2E', () => {
  test('empty brain → zero snapshot', async () => {
    const s = await readSnapshot(engine);
    expect(s.queue_health).toEqual({ waiting: 0, active: 0, stalled: 0 });
    expect(s.lease_pressure_1h).toBe(0);
    expect(s.top_errors).toEqual([]);
    expect(s.budget_owners).toEqual([]);
  });

  test('aggregates lease pressure + clustered errors + budget owners correctly', async () => {
    // 3 jobs in the queue (waiting).
    for (let i = 0; i < 3; i++) {
      await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    }
    // 5 lease bounces.
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    for (let i = 0; i < 5; i++) {
      await logLeasePressure(engine, {
        job_id: owner.id,
        lease_key: 'anthropic:messages',
        active_at_bounce: 8,
        max_concurrent: 8,
      });
    }
    // 2 dead jobs with classifiable errors.
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, queue, status, attempts_made, attempts_started, max_attempts, error_text, finished_at, updated_at)
       VALUES ('subagent', 'default', 'dead', 1, 1, 1, 'rate lease "anthropic:messages" full (8/8)', now(), now()),
              ('subagent', 'default', 'dead', 1, 1, 1, 'prompt is too long: 2M tokens', now(), now())`,
    );
    // One budget-bearing owner with cents.
    const budgetOwner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, budgetOwner.id, 5.0);

    const s = await readSnapshot(engine);
    // Queue health: 4 waiting from queue.add, +1 budget owner = 5 waiting.
    // Plus the 2 dead jobs counted as "completed-or-failed-or-dead" don't
    // increment waiting. So waiting = 4 (3 + 1 budget owner) + 1 owner = 5.
    expect(s.queue_health.waiting).toBeGreaterThan(0);
    expect(s.lease_pressure_1h).toBe(5);
    // Top errors: 2 distinct clusters (rate_lease_full + prompt_too_long).
    expect(s.top_errors.length).toBe(2);
    const clusters = s.top_errors.map(e => e.cluster);
    expect(clusters).toContain('rate_lease_full');
    expect(clusters).toContain('prompt_too_long');
    // Budget owner visible with remaining cents.
    expect(s.budget_owners.length).toBe(1);
    expect(s.budget_owners[0]!.owner_id).toBe(budgetOwner.id);
    expect(s.budget_owners[0]!.remaining_cents).toBe(500); // $5.00 = 500¢
  });
});
