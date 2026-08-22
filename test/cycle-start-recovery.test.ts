/**
 * Cycle-start orphaned-private-queue recovery lane (src/core/cycle.ts ~:2038).
 *
 * On engines that never run a supervisor/worker process (PGLite inlines every
 * child) this lane is the ONLY recovery net for dream-inline-* queues whose
 * owner job went terminal while children were still non-terminal. Pins:
 *   - a real runCycle (dryRun unset) cancels the orphan's children with the
 *     machine-readable 'private_queue_reconciled:' reason family carrying
 *     'cycle startup recovery';
 *   - dryRun: true never touches the fixture (recovery is a write and the
 *     whole block is gated on !dryRun).
 *
 * Harness: phases: [] is an explicit no-op cycle (no lock, zero phases — see
 * the empty-phase test in autopilot-global-maintenance.test.ts) but the
 * startup recovery block still runs, so each test costs milliseconds beyond
 * the shared engine boot.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runCycle } from '../src/core/cycle.ts';

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
  // Same pattern as test/autopilot-cycle-handler.test.ts.
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks').catch(() => {});
});

/**
 * Seed a provably-orphaned private dream queue: a waiting 'subagent' child
 * whose private_queue_owner_job_id points at a TERMINAL owner job, with
 * updated_at aged past the classifier's 2-minute recently-touched guard.
 */
async function seedOrphanQueue(): Promise<{ queueName: string; childId: number }> {
  const queueName = `dream-inline-cycle-recovery-${++queueSeq}`;
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
      private_queue_owner_token: 'cycle-recovery-token',
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

describe('cycle-start private-queue recovery lane', () => {
  test('a real cycle cancels an orphaned dream-inline queue with the cycle-startup reason', async () => {
    const { childId } = await seedOrphanQueue();

    const report = await runCycle(engine, { brainDir: null, phases: [] });
    expect(report.phases).toEqual([]); // explicit no-op cycle — recovery ran regardless

    const row = await childRow(childId);
    expect(row.status).toBe('cancelled');
    expect(row.error_text).toStartWith('private_queue_reconciled:');
    expect(row.error_text).toContain('cycle startup recovery');
  }, 60_000);

  test('dryRun: true leaves the orphan fixture untouched (still waiting)', async () => {
    const { childId } = await seedOrphanQueue();

    const report = await runCycle(engine, { brainDir: null, phases: [], dryRun: true });
    expect(report.phases).toEqual([]);

    const row = await childRow(childId);
    expect(row.status).toBe('waiting');
    expect(row.error_text).toBeNull();
  }, 60_000);
});
