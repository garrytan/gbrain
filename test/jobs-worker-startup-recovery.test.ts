/**
 * maybeRunWorkerStartupRecovery (src/commands/jobs.ts) — the bare-worker
 * arm of the orphaned-private-queue recovery net. A deployment that starts
 * `gbrain jobs work` directly (no supervisor) must still recover crashed
 * dream-inline-* queues; supervised children (GBRAIN_SUPERVISED=1) skip it
 * because their supervisor already ran the scan. Pins:
 *   - unsupervised env → orphan cancelled with the worker-startup reason;
 *   - GBRAIN_SUPERVISED=1 → fixture untouched;
 *   - a throwing queue → resolves (recovery failure never kills the worker);
 *   - structurally: the 'work' handler awaits the recovery right after
 *     ensureSchema, before the worker/work loop is constructed.
 *
 * Env is passed EXPLICITLY (the function's `env` parameter) so this file
 * never mutates process.env (isolation rule R1).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { maybeRunWorkerStartupRecovery } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let queueSeq = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Targeted DELETE preserves the `config.version` key that
  // MinionQueue.ensureSchema requires (full resetPgliteState wipes it).
  await engine.executeRaw('DELETE FROM minion_jobs');
});

/** Orphan fixture: waiting 'subagent' child, terminal owner, aged updated_at. */
async function seedOrphanQueue(): Promise<{ queueName: string; childId: number }> {
  const queueName = `dream-inline-worker-recovery-${++queueSeq}`;
  const owner = await queue.add('autopilot-cycle', {});
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
    [owner.id],
  );
  const child = await queue.add(
    'subagent',
    { prompt: 'orphan fixture' },
    {
      queue: queueName,
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'worker-recovery-token',
      private_queue_lease_ms: 600_000,
    },
    { allowProtectedSubmit: true },
  );
  await engine.executeRaw(
    `UPDATE minion_jobs SET updated_at = now() - interval '5 minutes' WHERE id = $1`,
    [child.id],
  );
  return { queueName, childId: child.id };
}

async function childRow(id: number): Promise<{ status: string; error_text: string | null }> {
  const rows = await engine.executeRaw<{ status: string; error_text: string | null }>(
    `SELECT status, error_text FROM minion_jobs WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

describe('maybeRunWorkerStartupRecovery', () => {
  test('unsupervised (GBRAIN_SUPERVISED unset) cancels the orphan with the worker-startup reason', async () => {
    const { childId } = await seedOrphanQueue();

    await maybeRunWorkerStartupRecovery(queue, {});

    const row = await childRow(childId);
    expect(row.status).toBe('cancelled');
    expect(row.error_text).toStartWith('private_queue_reconciled:');
    expect(row.error_text).toContain('worker startup recovery');
  });

  test('GBRAIN_SUPERVISED=1 skips recovery entirely (supervisor already ran it)', async () => {
    const { childId } = await seedOrphanQueue();

    await maybeRunWorkerStartupRecovery(queue, { GBRAIN_SUPERVISED: '1' });

    const row = await childRow(childId);
    expect(row.status).toBe('waiting');
    expect(row.error_text).toBeNull();
  });

  test('a throwing queue resolves without throwing (recovery failure never kills the worker)', async () => {
    class ThrowingQueue extends MinionQueue {
      override async reconcileOrphanedPrivateQueues(): Promise<never> {
        throw new Error('injected recovery failure');
      }
    }
    await expect(
      maybeRunWorkerStartupRecovery(new ThrowingQueue(engine), {}),
    ).resolves.toBeUndefined();
  });

});

// Structural (separate suite so the behavioral tests above stay classified
// behavioral; binding name is deliberately non-generic so the classifier's
// reference heuristic can't leak onto sibling suites).
describe('dream-inline queues stay live while a cycle lock is fresh', () => {
  async function seedCycleLock(refreshedAgo: string): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-cycle:default', 4, 'modal:ta-test', now() - interval '30 minutes',
               now() + interval '5 minutes', now() - ($1 || ' seconds')::interval)
       ON CONFLICT (id) DO UPDATE SET last_refreshed_at = EXCLUDED.last_refreshed_at`,
      [refreshedAgo],
    );
  }

  test('an orphan-looking queue survives recovery while a cycle lock was refreshed within 5 minutes', async () => {
    const { queueName, childId } = await seedOrphanQueue();
    await seedCycleLock('40');
    try {
      expect(await queue.classifyPrivateQueueForRecovery(queueName)).toBe('live');
      const r = await queue.reconcileOrphanedPrivateQueues({ reason: 'test' });
      expect(r.cancelled_jobs).toBe(0);
      expect((await childRow(childId)).status).toBe('waiting');
    } finally {
      await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle:default'`);
    }
  });

  test('the same queue is reaped once the cycle lock is stale (refreshed more than 5 minutes ago)', async () => {
    const { queueName, childId } = await seedOrphanQueue();
    await seedCycleLock('600');
    try {
      expect(await queue.classifyPrivateQueueForRecovery(queueName)).toBe('orphan');
      const r = await queue.reconcileOrphanedPrivateQueues({ reason: 'test' });
      expect(r.cancelled_jobs).toBe(1);
      expect((await childRow(childId)).status).toBe('cancelled');
    } finally {
      await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle:default'`);
    }
  });
});

describe('work-handler recovery placement (structural)', () => {
  test('the work handler awaits recovery right after ensureSchema, before the worker spawns', () => {
    const jobsSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'commands', 'jobs.ts'),
      'utf8',
    );
    const callSite = 'await maybeRunWorkerStartupRecovery(queue);';
    const callIdx = jobsSource.indexOf(callSite);
    expect(callIdx).toBeGreaterThan(-1);
    // Exactly one call site — the work handler.
    expect(jobsSource.indexOf(callSite, callIdx + 1)).toBe(-1);
    // Anchored immediately after the schema guard…
    const ensureIdx = jobsSource.lastIndexOf('await queue.ensureSchema();', callIdx);
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(callIdx - ensureIdx).toBeLessThan(400);
    // …and BEFORE the work loop's worker is even constructed.
    const workerIdx = jobsSource.indexOf('new MinionWorker(engine', callIdx);
    expect(workerIdx).toBeGreaterThan(callIdx);
  });
});
