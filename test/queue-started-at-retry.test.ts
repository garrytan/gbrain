/**
 * W0 fix-wave (Tier-1 #7) — started_at is reset on every AUTOMATIC re-run
 * path, so handleWallClockTimeouts (anchored on now() - started_at) measures
 * per-attempt runtime, never time a job spent parked in backoff.
 *
 * Pre-fix, only the manual `jobs retry` path cleared started_at (its
 * docstring documented the bug); the four automatic paths — failJob's
 * delayed branch, handleStalled's requeue, promoteDelayed, and
 * releaseLeaseFullJob (the 4th site, found in adversarial verification) —
 * all preserved the FIRST claim's timestamp, so an exponential-backoff job
 * could be dead-lettered by the wall-clock sweep before executing a single
 * line of its retry attempt.
 */

import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

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
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function jobStatus(id: number): Promise<string> {
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status FROM minion_jobs WHERE id = $1`, [id],
  );
  return rows[0]!.status;
}

async function startedAtOf(id: number): Promise<string | null> {
  const rows = await engine.executeRaw<{ started_at: string | null }>(
    `SELECT started_at::text AS started_at FROM minion_jobs WHERE id = $1`, [id],
  );
  return rows[0]?.started_at ?? null;
}

async function addAndClaim(name = 'noop'): Promise<{ id: number; token: string }> {
  const job = await queue.add(name, {});
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  const claimed = await queue.claim(token, 30_000, 'default', [name]);
  expect(claimed?.id).toBe(job.id);
  expect(await startedAtOf(job.id)).not.toBeNull();
  return { id: job.id, token };
}

test("failJob's delayed branch clears started_at (terminal branches keep it)", async () => {
  const { id, token } = await addAndClaim();
  const delayed = await queue.failJob(id, token, 'boom', 'delayed', 50);
  expect(delayed?.status).toBe('delayed');
  expect(await startedAtOf(id)).toBeNull();

  // Terminal failure keeps started_at (it feeds duration accounting).
  const { id: id2, token: token2 } = await addAndClaim();
  const dead = await queue.failJob(id2, token2, 'boom', 'dead');
  expect(dead?.status).toBe('dead');
  expect(await startedAtOf(id2)).not.toBeNull();
});

test("handleStalled's requeue branch clears started_at", async () => {
  const { id } = await addAndClaim();
  await engine.executeRaw(
    `UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1`, [id],
  );
  const { requeued } = await queue.handleStalled();
  expect(requeued.map(j => j.id)).toContain(id);
  expect(await startedAtOf(id)).toBeNull();
});

test('releaseLeaseFullJob clears started_at (lease bounce burns no wall-clock)', async () => {
  const { id, token } = await addAndClaim();
  const released = await queue.releaseLeaseFullJob(id, token, 'rate lease full (8/8)', 50);
  expect(released?.status).toBe('delayed');
  expect(await startedAtOf(id)).toBeNull();
});

test('promoteDelayed defensively clears any stale started_at', async () => {
  const job = await queue.add('noop', {});
  await engine.executeRaw(
    `UPDATE minion_jobs
        SET status = 'delayed', delay_until = now() - interval '1 second',
            started_at = now() - interval '1 hour'
      WHERE id = $1`, [job.id],
  );
  const promoted = await queue.promoteDelayed();
  expect(promoted.map(j => j.id)).toContain(job.id);
  expect(await startedAtOf(job.id)).toBeNull();
});

test('end-to-end: a retried job survives the wall-clock sweep on its fresh attempt', async () => {
  const { id, token } = await addAndClaim();
  // Simulate a long first attempt: backdate started_at far past the sweep
  // threshold (no timeout_ms → threshold = lockDurationMs * 2 * max_stalled).
  await engine.executeRaw(
    `UPDATE minion_jobs SET started_at = now() - interval '1 hour' WHERE id = $1`, [id],
  );
  await queue.failJob(id, token, 'first attempt failed', 'delayed', 0);
  const promoted = await queue.promoteDelayed();
  expect(promoted.map(j => j.id)).toContain(id);

  const token2 = 'tok-second-attempt';
  const reclaimed = await queue.claim(token2, 30_000, 'default', ['noop']);
  expect(reclaimed?.id).toBe(id);

  // Pre-fix: started_at still said now()-1h → 3.6M ms > 30_000*2*max_stalled
  // and the very next sweep dead-lettered the fresh attempt. Post-fix the
  // re-claim stamped a fresh started_at, so the sweep spares it.
  const killed = await queue.handleWallClockTimeouts(30_000);
  expect(killed.map(j => j.id)).not.toContain(id);

  // Negative control — the sweep itself still works: backdate the ACTIVE
  // attempt past the threshold and it dies.
  await engine.executeRaw(
    `UPDATE minion_jobs SET started_at = now() - interval '1 hour' WHERE id = $1`, [id],
  );
  const killed2 = await queue.handleWallClockTimeouts(30_000);
  expect(killed2.map(j => j.id)).toContain(id);
});

test('red-team 5th path: a re-claimed aggregator parent survives the wall-clock sweep', async () => {
  // Parent parked in waiting-children for LONGER than the wall-clock
  // threshold while its child runs; every unblock path (killJobs,
  // completeJob resolve, failJob branches, cancelJob, retroactive sweep,
  // resolveParent) must clear started_at, or claim()'s COALESCE keeps the
  // attempt-1 anchor and the sweep dead-letters the aggregation attempt
  // before it executes a line.
  const parent = await queue.add('agg-wallclock', {});
  const child = await queue.add('child-wc', {}, { parent_job_id: parent.id, max_stalled: 1 });
  // Parent claimed long ago (attempt-1 anchor), then parked waiting-children.
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'waiting-children', started_at = now() - interval '1 hour' WHERE id = $1`, [parent.id],
  );
  // Child stalls to death → killJobs unblocks the parent.
  await queue.claim('tok-wc', 30_000, 'default', ['child-wc', 'agg-wallclock']);
  await engine.executeRaw(
    `UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1`, [child.id],
  );
  await queue.handleStalled();
  expect(await jobStatus(parent.id)).toBe('waiting');
  // The fix: unblock cleared the stale anchor.
  expect(await startedAtOf(parent.id)).toBeNull();

  // Parent re-claims for its aggregation attempt → fresh anchor → survives.
  const reclaimed = await queue.claim('tok-wc2', 30_000, 'default', ['agg-wallclock', 'child-wc']);
  expect(reclaimed?.id).toBe(parent.id);
  const killed = await queue.handleWallClockTimeouts(30_000);
  expect(killed.map(j => j.id)).not.toContain(parent.id);
});
