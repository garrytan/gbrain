/**
 * W0 fix-wave (Tier-1 #4) — a child dead-lettered via max-stall must notify
 * and unblock its aggregator parent, exactly like timeout/failure kills do.
 *
 * Pre-fix, handleStalled's dead-letter branch emitted no child_done and never
 * flipped the parent out of 'waiting-children': the parent hung forever
 * unless it happened to carry its own timeout_ms (self-heal-proof — verified
 * in adversarial review: resolveParent has no periodic caller and the worker
 * only logged counts).
 */

import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { ChildDoneMessage } from '../src/core/minions/types.ts';

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
  await engine.executeRaw('DELETE FROM minion_inbox');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function jobStatus(id: number): Promise<string> {
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status FROM minion_jobs WHERE id = $1`, [id],
  );
  return rows[0]!.status;
}

test('stall-exhausted child → child_done(dead) in parent inbox + parent unblocked', async () => {
  const parent = await queue.add('aggregator', {});
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'waiting-children' WHERE id = $1`, [parent.id],
  );
  const child = await queue.add('child', {}, { parent_job_id: parent.id, max_stalled: 1 });

  // Claim the child, then expire its lock so the stall sweep sees it; with
  // max_stalled=1 the first stall dead-letters it.
  const claimed = await queue.claim('tok-stall', 30_000, 'default', ['child', 'aggregator']);
  expect(claimed?.id).toBe(child.id);
  await engine.executeRaw(
    `UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1`, [child.id],
  );

  const { requeued, dead } = await queue.handleStalled();
  expect(requeued).toHaveLength(0);
  expect(dead.map(j => j.id)).toEqual([child.id]);

  // The fix, part 1: parent got child_done with outcome 'dead'.
  const inbox = await engine.executeRaw<{ payload: unknown }>(
    `SELECT payload FROM minion_inbox WHERE job_id = $1`, [parent.id],
  );
  expect(inbox).toHaveLength(1);
  const msg = (typeof inbox[0]!.payload === 'string'
    ? JSON.parse(inbox[0]!.payload as string)
    : inbox[0]!.payload) as ChildDoneMessage;
  expect(msg.type).toBe('child_done');
  expect(msg.child_id).toBe(child.id);
  expect(msg.outcome).toBe('dead');
  expect(msg.error).toBe('max stalled count exceeded');

  // The fix, part 2: parent flipped out of waiting-children.
  expect(await jobStatus(parent.id)).toBe('waiting');
});

test('stall-requeued child (budget left) does NOT touch the parent', async () => {
  const parent = await queue.add('aggregator', {});
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'waiting-children' WHERE id = $1`, [parent.id],
  );
  const child = await queue.add('child', {}, { parent_job_id: parent.id, max_stalled: 5 });
  const claimed = await queue.claim('tok-stall2', 30_000, 'default', ['child', 'aggregator']);
  expect(claimed?.id).toBe(child.id);
  await engine.executeRaw(
    `UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1`, [child.id],
  );

  const { requeued, dead } = await queue.handleStalled();
  expect(dead).toHaveLength(0);
  expect(requeued.map(j => j.id)).toEqual([child.id]);
  expect(await jobStatus(child.id)).toBe('waiting');

  const inbox = await engine.executeRaw<{ payload: unknown }>(
    `SELECT payload FROM minion_inbox WHERE job_id = $1`, [parent.id],
  );
  expect(inbox).toHaveLength(0);
  expect(await jobStatus(parent.id)).toBe('waiting-children');
});

test('all three reapers route through the shared kill tail with their own outcome/error (D5.5)', async () => {
  // handleTimeouts → outcome 'timeout', error 'timeout exceeded'
  const p1 = await queue.add('agg1', {});
  await engine.executeRaw(`UPDATE minion_jobs SET status = 'waiting-children' WHERE id = $1`, [p1.id]);
  const c1 = await queue.add('c1', {}, { parent_job_id: p1.id });
  await queue.claim('t1', 30_000, 'default', ['c1', 'agg1']);
  await engine.executeRaw(
    `UPDATE minion_jobs SET timeout_at = now() - interval '1 second', lock_until = now() + interval '1 minute' WHERE id = $1`, [c1.id],
  );
  await queue.handleTimeouts();

  // handleWallClockTimeouts → outcome 'timeout', error 'wall-clock timeout exceeded'
  const p2 = await queue.add('agg2', {});
  await engine.executeRaw(`UPDATE minion_jobs SET status = 'waiting-children' WHERE id = $1`, [p2.id]);
  const c2 = await queue.add('c2', {}, { parent_job_id: p2.id });
  await queue.claim('t2', 30_000, 'default', ['c2', 'agg2']);
  await engine.executeRaw(
    `UPDATE minion_jobs SET started_at = now() - interval '2 hours' WHERE id = $1`, [c2.id],
  );
  await queue.handleWallClockTimeouts(30_000);

  const expectMsg = async (parentId: number, childId: number, outcome: string, error: string) => {
    const inbox = await engine.executeRaw<{ payload: unknown }>(
      `SELECT payload FROM minion_inbox WHERE job_id = $1`, [parentId],
    );
    expect(inbox).toHaveLength(1);
    const msg = (typeof inbox[0]!.payload === 'string'
      ? JSON.parse(inbox[0]!.payload as string)
      : inbox[0]!.payload) as ChildDoneMessage;
    expect(msg.child_id).toBe(childId);
    expect(msg.outcome).toBe(outcome as ChildDoneMessage['outcome']);
    expect(msg.error).toBe(error);
    expect(await jobStatus(parentId)).toBe('waiting');
  };
  await expectMsg(p1.id, c1.id, 'timeout', 'timeout exceeded');
  await expectMsg(p2.id, c2.id, 'timeout', 'wall-clock timeout exceeded');
});

test('retroactive sweep: a parent stranded BEFORE the fix (children already dead) self-heals on the next stall tick', async () => {
  // Simulate the pre-upgrade world: child is already terminal ('dead') with
  // NO child_done ever emitted, parent parked in waiting-children. No
  // per-kill unblock will ever revisit this pair — only the sweep can.
  const parent = await queue.add('agg-stranded', {});
  const child = await queue.add('child-stranded', {}, { parent_job_id: parent.id });
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'waiting-children' WHERE id = $1`, [parent.id],
  );
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'dead', error_text = 'max stalled count exceeded (pre-upgrade)' WHERE id = $1`, [child.id],
  );

  const { requeued, dead } = await queue.handleStalled();
  expect(requeued).toHaveLength(0);
  expect(dead).toHaveLength(0);
  // The sweep healed the stranded parent even though THIS tick killed nothing.
  expect(await jobStatus(parent.id)).toBe('waiting');
});

test('retroactive sweep does NOT unblock a parent with a live child', async () => {
  const parent = await queue.add('agg-live', {});
  await queue.add('child-live', {}, { parent_job_id: parent.id });
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'waiting-children' WHERE id = $1`, [parent.id],
  );
  await queue.handleStalled();
  expect(await jobStatus(parent.id)).toBe('waiting-children');
});
