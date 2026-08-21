/**
 * Lane 1B regression + coverage for the v0.15 queue changes:
 *
 *  - failJob emits child_done(outcome='failed'|'dead') on terminal transition,
 *    BEFORE the parent-terminal UPDATE (insertion order matters so the EXISTS
 *    guard on inbox writes doesn't drop the row on fail_parent paths).
 *  - cancelJob emits child_done(outcome='cancelled') to every descendant's
 *    parent inbox.
 *  - handleTimeouts emits child_done(outcome='timeout') to the parent inbox.
 *  - Parent-resolution terminal set includes 'failed' so a failed child with
 *    on_child_fail='continue' unblocks the aggregator.
 *  - MinionJobInput.max_stalled threads through MinionQueue.add() on INSERT.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue, DEFAULT_PRIVATE_QUEUE_LEASE_MS } from '../src/core/minions/queue.ts';
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
  await engine.executeRaw('DELETE FROM minion_jobs');
});

// Helper: read all child_done payloads from a parent's inbox.
async function readChildDoneInbox(parentId: number): Promise<ChildDoneMessage[]> {
  const rows = await engine.executeRaw<{ payload: unknown }>(
    `SELECT payload FROM minion_inbox WHERE job_id = $1 ORDER BY id`,
    [parentId]
  );
  return rows
    .map(r => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as ChildDoneMessage)
    .filter(p => p?.type === 'child_done');
}

let tokenSeq = 0;
function nextToken() { return `tok-${++tokenSeq}`; }

// Claim + fail the next job on the default queue for the given name.
async function claimAndFail(name: string, newStatus: 'failed' | 'dead', errorText = 'boom') {
  const token = nextToken();
  const claimed = await queue.claim(token, 30000, 'default', [name]);
  if (!claimed) throw new Error(`nothing to claim for ${name}`);
  return queue.failJob(claimed.id, token, errorText, newStatus);
}

// Claim + complete the next job on the default queue for the given name.
async function claimAndComplete(name: string, result: Record<string, unknown> = {}) {
  const token = nextToken();
  const claimed = await queue.claim(token, 30000, 'default', [name]);
  if (!claimed) throw new Error(`nothing to claim for ${name}`);
  return queue.completeJob(claimed.id, token, result);
}

describe('v0.15 child_done emission', () => {
  test('completeJob emits child_done with outcome=complete (regression)', async () => {
    const parent = await queue.add('parent', {});
    const child = await queue.add('child', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });

    await claimAndComplete('child', { ok: 1 });

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].outcome).toBe('complete');
    expect(msgs[0].child_id).toBe(child.id);
    expect(msgs[0].result).toEqual({ ok: 1 });
    expect(msgs[0].error).toBeUndefined();
  });

  test('failJob emits child_done(outcome=failed) on terminal failure with on_child_fail=continue', async () => {
    const parent = await queue.add('parent', {});
    const child = await queue.add('child', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });

    await claimAndFail('child', 'failed', 'kaboom');

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].outcome).toBe('failed');
    expect(msgs[0].error).toBe('kaboom');
  });

  test('failJob emits child_done(outcome=dead) when newStatus=dead', async () => {
    const parent = await queue.add('parent', {});
    const child = await queue.add('child', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });

    await claimAndFail('child', 'dead', 'exceeded attempts');

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].outcome).toBe('dead');
  });

  test('failJob does NOT emit child_done on a delayed retry (not terminal)', async () => {
    const parent = await queue.add('parent', {});
    const child = await queue.add('child', {}, { parent_job_id: parent.id });

    const token = nextToken();
    const claimed = await queue.claim(token, 30000, 'default', ['child']);
    if (!claimed) throw new Error('no claim');
    await queue.failJob(claimed.id, token, 'transient', 'delayed', 1000);

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(0);
  });

  test('failJob with fail_parent emits child_done BEFORE parent-terminal UPDATE (insertion order)', async () => {
    // Regression: if the parent-UPDATE ran first, the EXISTS guard on the
    // child_done INSERT would skip the row once parent.status='failed'. The
    // aggregator would then be unable to see the failure in its inbox.
    const parent = await queue.add('parent', {});
    const child = await queue.add('child', {}, { parent_job_id: parent.id, on_child_fail: 'fail_parent' });

    await claimAndFail('child', 'failed', 'parent kill');

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].outcome).toBe('failed');

    // And the parent-terminal UPDATE still ran.
    const parentNow = await queue.getJob(parent.id);
    expect(parentNow?.status).toBe('failed');
  });

  test('cancelJob on an individual child emits child_done(outcome=cancelled) to its aggregator parent', async () => {
    // This is the real codex scenario: the aggregator (parent) is alive in
    // waiting-children, and a sibling child gets cancelled. The aggregator
    // must see the child_done so it can count "N children resolved" and
    // eventually produce its summary.
    const parent = await queue.add('parent', {});
    const c1 = await queue.add('child1', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });

    await queue.cancelJob(c1.id);

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].outcome).toBe('cancelled');
    expect(msgs[0].child_id).toBe(c1.id);

    // And the aggregator parent itself was unblocked (no non-terminal kids).
    const p = await queue.getJob(parent.id);
    expect(p?.status).toBe('waiting');
  });

  test('cancelJob cascading from parent is a no-op for the terminal parent\'s inbox (by design)', async () => {
    // When the aggregator itself is cancelled, cascading also cancels its
    // children. The child_done writes for those children would target the
    // (now-terminal) parent's inbox — the EXISTS guard drops them, which is
    // correct: a cancelled aggregator won't process its inbox anyway.
    const parent = await queue.add('parent', {});
    await queue.add('child1', {}, { parent_job_id: parent.id });
    await queue.add('child2', {}, { parent_job_id: parent.id });

    await queue.cancelJob(parent.id);

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(0);

    // But the cancellation itself succeeded.
    const p = await queue.getJob(parent.id);
    expect(p?.status).toBe('cancelled');
  });

  test('handleTimeouts emits child_done(outcome=timeout) to parent inbox', async () => {
    const parent = await queue.add('parent', {});
    const child = await queue.add('child', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });

    const token = nextToken();
    const claimed = await queue.claim(token, 30000, 'default', ['child']);
    if (!claimed) throw new Error('no claim');
    // Force a past timeout_at for this claimed job.
    await engine.executeRaw(
      `UPDATE minion_jobs SET timeout_at = now() - interval '1 second' WHERE id = $1`,
      [claimed.id]
    );
    const timed = await queue.handleTimeouts();
    expect(timed.length).toBe(1);

    const msgs = await readChildDoneInbox(parent.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].outcome).toBe('timeout');
  });
});

describe('v0.15 parent-resolution terminal set', () => {
  test('failed child with on_child_fail=continue unblocks aggregator parent', async () => {
    const parent = await queue.add('parent', {});
    const c1 = await queue.add('child1', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });
    const c2 = await queue.add('child2', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });

    // Parent should be waiting-children after fan-out.
    let p = await queue.getJob(parent.id);
    expect(p?.status).toBe('waiting-children');

    // Fail c1.
    await claimAndFail('child1', 'failed');
    // Parent still waiting-children (c2 open).
    p = await queue.getJob(parent.id);
    expect(p?.status).toBe('waiting-children');

    // Complete c2.
    await claimAndComplete('child2', { ok: 1 });
    // Parent unblocked.
    p = await queue.getJob(parent.id);
    expect(p?.status).toBe('waiting');
  });

  test('all-failed children still unblock the parent', async () => {
    const parent = await queue.add('parent', {});
    const c1 = await queue.add('child1', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });
    const c2 = await queue.add('child2', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });

    await claimAndFail('child1', 'failed');
    await claimAndFail('child2', 'failed');

    const p = await queue.getJob(parent.id);
    expect(p?.status).toBe('waiting');
  });
});

describe('private queue terminal reconciliation', () => {
  test('cancels every non-terminal job in the owned queue and preserves unrelated work', async () => {
    const privateQueue = `dream-inline-${Date.now()}-deadbeef`;
    const waiting = await queue.add('private-waiting', {}, { queue: privateQueue });
    const active = await queue.add('private-active', {}, { queue: privateQueue });
    const unrelated = await queue.add('unrelated', {}, { queue: 'default' });
    const claimed = await queue.claim(nextToken(), 30_000, privateQueue, ['private-active']);
    expect(claimed?.id).toBe(active.id);

    const reconciled = await queue.reconcilePrivateQueue(privateQueue, 'owner terminalized');

    expect(reconciled.map(j => j.id).sort((a, b) => a - b)).toEqual([waiting.id, active.id].sort((a, b) => a - b));
    expect((await queue.getJob(waiting.id))?.status).toBe('cancelled');
    expect((await queue.getJob(active.id))?.status).toBe('cancelled');
    expect((await queue.getJob(waiting.id))?.error_text).toBe('private_queue_reconciled: owner terminalized');
    expect((await queue.getJob(unrelated.id))?.status).toBe('waiting');

    // Idempotent: a second finally/recovery pass finds nothing to do.
    expect(await queue.reconcilePrivateQueue(privateQueue, 'second pass')).toEqual([]);
  });

  test('refuses to reconcile a shared queue', async () => {
    await expect(queue.reconcilePrivateQueue('default', 'bad target')).rejects.toThrow('refusing to reconcile non-private queue');
  });

  test('startup recovery cancels an ownerless private queue only after its lease expires', async () => {
    const privateQueue = `dream-inline-${Date.now()}-expired1`;
    const token = 'ownerless-expired';
    const job = await queue.add('private-waiting', {}, {
      queue: privateQueue,
      private_queue_owner_token: token,
      private_queue_lease_ms: 600_000,
    });
    // A crashed run's rows go untouched — age updated_at past the 2-minute
    // recently-touched guard so the fixture models a real crash, not a queue
    // something is actively working.
    await engine.executeRaw(
      `UPDATE minion_jobs SET private_queue_lease_until = now() - interval '1 second', updated_at = now() - interval '5 minutes' WHERE id = $1`,
      [job.id],
    );

    const first = await queue.reconcileOrphanedPrivateQueues({ reason: 'test startup recovery' });
    expect(first.cancelled_jobs).toBe(1);
    expect(first.cancelled_queues).toBe(1);
    expect((await queue.getJob(job.id))?.status).toBe('cancelled');
    expect((await queue.getJob(job.id))?.error_text).toBe('private_queue_reconciled: test startup recovery');

    const second = await queue.reconcileOrphanedPrivateQueues({ reason: 'second pass' });
    expect(second.cancelled_jobs).toBe(0);
    expect(second.cancelled_queues).toBe(0);
  });

  test('startup recovery never cancels a private queue with a future lease', async () => {
    const privateQueue = `dream-inline-${Date.now()}-future1`;
    const job = await queue.add('private-waiting', {}, {
      queue: privateQueue,
      private_queue_owner_token: 'ownerless-live',
      private_queue_lease_ms: 600_000,
    });

    const result = await queue.reconcileOrphanedPrivateQueues();
    expect(result.cancelled_jobs).toBe(0);
    expect(result.skipped_live_queues).toBeGreaterThanOrEqual(1);
    expect((await queue.getJob(job.id))?.status).toBe('waiting');
  });

  test('startup recovery never cancels a private queue whose owner job is live', async () => {
    const owner = await queue.add('autopilot-cycle', {});
    const ownerToken = nextToken();
    const claimedOwner = await queue.claim(ownerToken, 30_000, 'default', ['autopilot-cycle']);
    expect(claimedOwner?.id).toBe(owner.id);
    const privateQueue = `dream-inline-${Date.now()}-liveown`;
    const child = await queue.add('private-waiting', {}, {
      queue: privateQueue,
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'live-owner-token',
      private_queue_lease_ms: 1,
    });
    await engine.executeRaw(
      `UPDATE minion_jobs SET private_queue_lease_until = now() - interval '1 second' WHERE id = $1`,
      [child.id],
    );

    const result = await queue.reconcileOrphanedPrivateQueues();
    expect(result.cancelled_jobs).toBe(0);
    expect(result.skipped_live_queues).toBeGreaterThanOrEqual(1);
    expect((await queue.getJob(child.id))?.status).toBe('waiting');
  });

  test('startup recovery cancels when the owner job is terminal even if the lease has not expired', async () => {
    const owner = await queue.add('autopilot-cycle', {});
    await claimAndComplete('autopilot-cycle', { ok: true });
    const privateQueue = `dream-inline-${Date.now()}-termown`;
    const child = await queue.add('private-waiting', {}, {
      queue: privateQueue,
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'terminal-owner-token',
      private_queue_lease_ms: 600_000,
    });

    // Age past the recently-touched guard (see the expired-lease fixture note).
    await engine.executeRaw(
      `UPDATE minion_jobs SET updated_at = now() - interval '5 minutes' WHERE id = $1`,
      [child.id],
    );

    const result = await queue.reconcileOrphanedPrivateQueues({ reason: 'owner terminal' });
    expect(result.cancelled_jobs).toBe(1);
    expect((await queue.getJob(child.id))?.status).toBe('cancelled');
    expect((await queue.getJob(child.id))?.error_text).toBe('private_queue_reconciled: owner terminal');
  });

  test('startup recovery preserves legacy unowned private queues for manual Doctor/retriage handling', async () => {
    const privateQueue = `dream-inline-${Date.now()}-legacy1`;
    const job = await queue.add('legacy-private-waiting', {}, { queue: privateQueue });

    const result = await queue.reconcileOrphanedPrivateQueues();
    expect(result.cancelled_jobs).toBe(0);
    // The scan's HAVING excludes metadata-less queues at the SQL level (they
    // are never recoverable by this lane and must not occupy the LIMIT
    // window), so they no longer even count as scanned/skipped.
    expect(result.skipped_unowned_queues).toBe(0);
    expect((await queue.getJob(job.id))?.status).toBe('waiting');
  });

  test('startup recovery uses normal cancellation semantics for descendants and aggregators', async () => {
    const owner = await queue.add('autopilot-cycle', {});
    await claimAndComplete('autopilot-cycle', { ok: true });
    const aggregator = await queue.add('aggregator', {});
    const privateQueue = `dream-inline-${Date.now()}-tree001`;
    const child = await queue.add('private-child', {}, {
      queue: privateQueue,
      parent_job_id: aggregator.id,
      on_child_fail: 'continue',
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'tree-token',
      private_queue_lease_ms: 600_000,
    });
    const grandchild = await queue.add('private-grandchild', {}, {
      queue: privateQueue,
      parent_job_id: child.id,
      on_child_fail: 'continue',
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'tree-token',
      private_queue_lease_ms: 600_000,
    });

    // Age past the recently-touched guard (see the expired-lease fixture note).
    await engine.executeRaw(
      `UPDATE minion_jobs SET updated_at = now() - interval '5 minutes' WHERE id = ANY($1::int[])`,
      [[child.id, grandchild.id]],
    );

    const result = await queue.reconcileOrphanedPrivateQueues({ reason: 'owner terminal tree' });
    expect(result.cancelled_jobs).toBeGreaterThanOrEqual(2);
    expect((await queue.getJob(child.id))?.status).toBe('cancelled');
    expect((await queue.getJob(grandchild.id))?.status).toBe('cancelled');
    expect((await queue.getJob(aggregator.id))?.status).toBe('waiting');
    const msgs = await readChildDoneInbox(aggregator.id);
    expect(msgs.some(m => m.child_id === child.id && m.outcome === 'cancelled')).toBe(true);
  });
});

describe('recovery freshness guard (fix-wave review)', () => {
  test('a terminal-owner queue touched in the last 2 minutes is LIVE, never cancelled', async () => {
    // The laptop-sleep shape: the owner job row went terminal (stall-swept)
    // but the drain loop survived and still renews/claims — updated_at is
    // fresh. Recovery must classify live and touch nothing; the queue becomes
    // orphaned only after 2 minutes of silence.
    const owner = await queue.add('autopilot-cycle', {});
    await claimAndComplete('autopilot-cycle', { ok: true });
    const privateQueue = `dream-inline-${Date.now()}-fresh01`;
    const child = await queue.add('private-waiting', {}, {
      queue: privateQueue,
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'fresh-token',
      private_queue_lease_ms: 600_000,
    });
    expect(await queue.classifyPrivateQueueForRecovery(privateQueue)).toBe('live');
    const result = await queue.reconcileOrphanedPrivateQueues({ reason: 'must not fire' });
    expect(result.cancelled_jobs).toBe(0);
    expect((await queue.getJob(child.id))?.status).toBe('waiting');
  });

  test('renewPrivateQueueLease negative paths: wrong token renews nothing; empty token and shared queues throw', async () => {
    const privateQueue = `dream-inline-${Date.now()}-neg001`;
    await queue.add('private-waiting', {}, {
      queue: privateQueue,
      private_queue_owner_token: 'right-token',
      private_queue_lease_ms: 600_000,
    });
    expect(await queue.renewPrivateQueueLease(privateQueue, 'wrong-token')).toBe(0);
    await expect(queue.renewPrivateQueueLease(privateQueue, '')).rejects.toThrow('owner token cannot be empty');
    await expect(queue.renewPrivateQueueLease('default', 'right-token')).rejects.toThrow('refusing to renew non-private queue');
  });

  test('owner nonterminal without a lease classifies not_orphan and is skipped', async () => {
    const owner = await queue.add('autopilot-cycle', {}); // stays waiting (non-terminal)
    const privateQueue = `dream-inline-${Date.now()}-pend01`;
    const child = await queue.add('private-waiting', {}, {
      queue: privateQueue,
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'pending-token',
    });
    await engine.executeRaw(
      `UPDATE minion_jobs SET updated_at = now() - interval '5 minutes' WHERE id = $1`,
      [child.id],
    );
    expect(await queue.classifyPrivateQueueForRecovery(privateQueue)).toBe('not_orphan');
    const result = await queue.reconcileOrphanedPrivateQueues();
    expect(result.cancelled_jobs).toBe(0);
    expect(result.skipped_non_orphan_queues).toBeGreaterThanOrEqual(1);
    expect((await queue.getJob(child.id))?.status).toBe('waiting');
  });
});

describe('v0.16 MinionJobInput.max_stalled', () => {
  test('default max_stalled picks up schema DEFAULT when omitted (regression)', async () => {
    // v0.14.3 bumped the schema column DEFAULT from 1 → 5 (max_stalled becomes
    // tolerant of short-lock blips for long-running LLM handlers). The v0.16
    // queue.add conditional-insert skips the column when the caller omits it,
    // so the schema DEFAULT is what actually stores. Pin the current default
    // rather than hardcoding the number.
    const job = await queue.add('child', {});
    expect(job.max_stalled).toBeGreaterThanOrEqual(1);
    expect(job.max_stalled).toBeLessThanOrEqual(100);
    // As of v0.14.3 the default is 5. If someone re-migrates the default up,
    // this assertion will fire and they can update it intentionally.
    expect(job.max_stalled).toBe(5);
  });

  test('per-job max_stalled override threads through INSERT', async () => {
    const job = await queue.add('durable', {}, { max_stalled: 3 });
    expect(job.max_stalled).toBe(3);
  });

  test('idempotency-key replay does NOT mutate existing max_stalled', async () => {
    const first = await queue.add('job', {}, { idempotency_key: 'k1', max_stalled: 3 });
    const second = await queue.add('job', {}, { idempotency_key: 'k1', max_stalled: 7 });
    expect(second.id).toBe(first.id);
    // First submitter wins; second submitter's override is silently ignored
    // (per codex iteration 3 finding — mutation would be a footgun).
    expect(second.max_stalled).toBe(3);
  });
});

describe('private queue lease + wedge-signal hardening (fix wave)', () => {
  test('lease renewal is MONOTONIC: a default-horizon renewal never shrinks a longer creation-time lease', async () => {
    const q = 'dream-inline-monotonic';
    const job = await queue.add('subagent', {}, {
      queue: q,
      private_queue_owner_token: 'tok-mono',
      // Creation-time horizon: 2 hours (a long phase's wait timeout).
      private_queue_lease_ms: 2 * 60 * 60 * 1000,
    }, { allowProtectedSubmit: true });
    const before = await engine.executeRaw<{ lease: string }>(
      `SELECT private_queue_lease_until::text AS lease FROM minion_jobs WHERE id = $1`, [job.id],
    );
    // Renew with the (shorter) 10-min default — GREATEST must keep the 2h horizon.
    const renewed = await queue.renewPrivateQueueLease(q, 'tok-mono');
    expect(renewed).toBe(1);
    const after = await engine.executeRaw<{ lease: string }>(
      `SELECT private_queue_lease_until::text AS lease FROM minion_jobs WHERE id = $1`, [job.id],
    );
    expect(new Date(after[0].lease).getTime()).toBeGreaterThanOrEqual(new Date(before[0].lease).getTime());
    // And a LONGER explicit horizon still extends.
    await queue.renewPrivateQueueLease(q, 'tok-mono', 4 * 60 * 60 * 1000);
    const extended = await engine.executeRaw<{ lease: string }>(
      `SELECT private_queue_lease_until::text AS lease FROM minion_jobs WHERE id = $1`, [job.id],
    );
    expect(new Date(extended[0].lease).getTime()).toBeGreaterThan(new Date(after[0].lease).getTime());
  });

  test('reconcile reason family: every cancellation is stamped with the machine-readable prefix', async () => {
    const q = 'dream-inline-reason-family';
    const job = await queue.add('subagent', {}, { queue: q }, { allowProtectedSubmit: true });
    const cancelled = await queue.reconcilePrivateQueue(q, 'anything a call site writes');
    expect(cancelled).toHaveLength(1);
    const row = await queue.getJob(job.id);
    expect(row?.error_text?.startsWith('private_queue_reconciled: ')).toBe(true);
  });

  test('deriveWedgeSignal never calls a dream-inline queue wedged — it reports private_queue instead', async () => {
    const { deriveWedgeSignal } = await import('../src/core/minions/queue.ts');
    const shape = { active_healthy: 0, waiting: 5, minutes_since_completion: 120 };
    const shared = deriveWedgeSignal({ ...shape, queue: 'default' });
    expect(shared.wedged).toBe(true);
    expect(shared.private_queue).toBe(false);
    // The incident bug class: a private queue must NEVER produce the
    // "restart the worker" wedge signal — no worker can claim it.
    const priv = deriveWedgeSignal({ ...shape, queue: 'dream-inline-123-abc' });
    expect(priv.wedged).toBe(false);
    expect(priv.private_queue).toBe(true);
  });
});

describe('makeThrottledLeaseRenewer (shared phase keepalive)', () => {
  async function readLease(id: number): Promise<number | null> {
    const rows = await engine.executeRaw<{ lease: string | null }>(
      `SELECT private_queue_lease_until::text AS lease FROM minion_jobs WHERE id = $1`, [id],
    );
    return rows[0].lease === null ? null : new Date(rows[0].lease).getTime();
  }

  test('first call renews then yields; second call inside the throttle is a no-op for BOTH', async () => {
    const q = 'dream-inline-renewer-throttle';
    const job = await queue.add('subagent', {}, {
      queue: q, private_queue_owner_token: 'tok-renewer', private_queue_lease_ms: 1000,
    }, { allowProtectedSubmit: true });
    const order: string[] = [];
    let leaseWhenYielded: number | null = null;
    const renew = queue.makeThrottledLeaseRenewer(q, 'tok-renewer', async () => {
      order.push('yield');
      leaseWhenYielded = await readLease(job.id);
    });
    const before = await readLease(job.id);
    await renew();
    const after = await readLease(job.id);
    expect(after!).toBeGreaterThan(before!);
    // Order is fixed: the lease was already extended when onRenewed ran.
    expect(order).toEqual(['yield']);
    expect(leaseWhenYielded!).toBe(after!);
    // Inside the 30s throttle window: neither the renew nor the yield fires.
    await renew();
    expect(order).toEqual(['yield']);
    expect(await readLease(job.id)).toBe(after);
  });

  test('throttleMs elapses → renews again; onRenewed is optional', async () => {
    const q = 'dream-inline-renewer-elapse';
    const job = await queue.add('subagent', {}, {
      queue: q, private_queue_owner_token: 'tok-elapse', private_queue_lease_ms: 1000,
    }, { allowProtectedSubmit: true });
    const renew = queue.makeThrottledLeaseRenewer(q, 'tok-elapse', undefined, 0);
    await renew();
    const first = await readLease(job.id);
    await new Promise(r => setTimeout(r, 5));
    await renew();
    expect((await readLease(job.id))!).toBeGreaterThanOrEqual(first!);
  });

  test('a throwing renewal propagates to the caller (shared queue refused)', async () => {
    const renew = queue.makeThrottledLeaseRenewer('default', 'tok-shared');
    await expect(renew()).rejects.toThrow('refusing to renew non-private queue');
  });
});

describe('private queue recovery classification + lease hardening (lane A backfill)', () => {
  async function readLeaseMs(id: number): Promise<number | null> {
    const rows = await engine.executeRaw<{ lease: string | null }>(
      `SELECT private_queue_lease_until::text AS lease FROM minion_jobs WHERE id = $1`, [id],
    );
    return rows[0].lease === null ? null : new Date(rows[0].lease).getTime();
  }

  // Age past the 2-minute recently-touched guard so the freshness fast path
  // cannot mask the arm under test (see the expired-lease fixture note above).
  async function ageUpdatedAt(ids: number[]): Promise<void> {
    await engine.executeRaw(
      `UPDATE minion_jobs SET updated_at = now() - interval '5 minutes' WHERE id = ANY($1::int[])`,
      [ids],
    );
  }

  test('K10: lease-only queue with a FUTURE lease classifies live even when updated_at is stale', async () => {
    // The long-quiet-subagent safety arm: no owner metadata, nothing touched
    // the rows in >2min (freshness guard does NOT short-circuit), but the
    // creation-time lease is still hours out — recovery must skip it.
    const q = `dream-inline-${Date.now()}-k10lease`;
    const job = await queue.add('private-waiting', {}, {
      queue: q,
      private_queue_lease_ms: 2 * 60 * 60 * 1000,
    });
    await ageUpdatedAt([job.id]);

    expect(await queue.classifyPrivateQueueForRecovery(q)).toBe('live');
    const result = await queue.reconcileOrphanedPrivateQueues({ reason: 'must not fire' });
    expect(result.cancelled_jobs).toBe(0);
    expect(result.skipped_live_queues).toBe(1);
    expect((await queue.getJob(job.id))?.status).toBe('waiting');
  });

  test('K2: an actively claimed child with a healthy lock classifies live despite stale updated_at and expired lease', async () => {
    const q = `dream-inline-${Date.now()}-k2active`;
    const job = await queue.add('private-active', {}, {
      queue: q,
      private_queue_owner_token: 'k2-token',
      private_queue_lease_ms: 600_000,
    });
    const claimed = await queue.claim(nextToken(), 30_000, q, ['private-active']);
    expect(claimed?.id).toBe(job.id);
    // Expire the lease and age updated_at — the healthy lock alone keeps it live.
    await engine.executeRaw(
      `UPDATE minion_jobs SET private_queue_lease_until = now() - interval '1 second', updated_at = now() - interval '5 minutes' WHERE id = $1`,
      [job.id],
    );

    expect(await queue.classifyPrivateQueueForRecovery(q)).toBe('live');
    const result = await queue.reconcileOrphanedPrivateQueues();
    expect(result.cancelled_jobs).toBe(0);
    expect(result.skipped_live_queues).toBe(1);
    expect((await queue.getJob(job.id))?.status).toBe('active');
  });

  test('L6: renewPrivateQueueLease returns 0 when every job in the queue is terminal', async () => {
    const q = `dream-inline-${Date.now()}-l6term`;
    const job = await queue.add('private-active', {}, {
      queue: q,
      private_queue_owner_token: 'l6-token',
      private_queue_lease_ms: 600_000,
    });
    const token = nextToken();
    const claimed = await queue.claim(token, 30_000, q, ['private-active']);
    expect(claimed?.id).toBe(job.id);
    await queue.completeJob(job.id, token, { ok: true });

    expect(await queue.renewPrivateQueueLease(q, 'l6-token')).toBe(0);
  });

  test('L4: renew COALESCEs a NULL lease — returns 1 and stamps ~now + default horizon', async () => {
    const q = `dream-inline-${Date.now()}-l4null`;
    const job = await queue.add('private-waiting', {}, {
      queue: q,
      private_queue_owner_token: 'l4-token',
      // NO private_queue_lease_ms: the row starts with a NULL lease.
    });
    expect(await readLeaseMs(job.id)).toBeNull();

    const before = Date.now();
    expect(await queue.renewPrivateQueueLease(q, 'l4-token')).toBe(1);
    const lease = await readLeaseMs(job.id);
    expect(lease).not.toBeNull();
    expect(lease!).toBeGreaterThanOrEqual(before + DEFAULT_PRIVATE_QUEUE_LEASE_MS - 60_000);
    expect(lease!).toBeLessThanOrEqual(Date.now() + DEFAULT_PRIVATE_QUEUE_LEASE_MS + 60_000);
  });

  test('add() clamps private_queue_lease_ms 0 and negatives to the 1ms floor without crashing', async () => {
    const qZero = `dream-inline-${Date.now()}-clamp0`;
    const zero = await queue.add('private-waiting', {}, { queue: qZero, private_queue_lease_ms: 0 });
    const zeroLease = await readLeaseMs(zero.id);
    expect(zeroLease).not.toBeNull();
    expect(Math.abs(zeroLease! - Date.now())).toBeLessThan(10_000);

    const qNeg = `dream-inline-${Date.now()}-clampneg`;
    const neg = await queue.add('private-waiting', {}, { queue: qNeg, private_queue_lease_ms: -3_600_000 });
    const negLease = await readLeaseMs(neg.id);
    expect(negLease).not.toBeNull();
    // Floored at 1ms after submit — NOT an hour in the past.
    expect(negLease!).toBeGreaterThan(Date.now() - 10_000);
  });

  test('renewPrivateQueueLease with leaseMs 0 clamps to 1ms and GREATEST never shrinks the horizon', async () => {
    const q = `dream-inline-${Date.now()}-renew0`;
    const job = await queue.add('private-waiting', {}, {
      queue: q,
      private_queue_owner_token: 'renew0-token',
      private_queue_lease_ms: 600_000,
    });
    const before = await readLeaseMs(job.id);
    expect(await queue.renewPrivateQueueLease(q, 'renew0-token', 0)).toBe(1);
    const after = await readLeaseMs(job.id);
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThanOrEqual(before!);
  });

  test('reconcilePrivateQueue does not double-stamp an already-prefixed reason', async () => {
    const q = `dream-inline-${Date.now()}-prefix1`;
    const job = await queue.add('private-waiting', {}, { queue: q });
    const cancelled = await queue.reconcilePrivateQueue(q, 'private_queue_reconciled: caller stamped');
    expect(cancelled).toHaveLength(1);
    const row = await queue.getJob(job.id);
    expect(row?.error_text).toBe('private_queue_reconciled: caller stamped');
    expect(row!.error_text!.split('private_queue_reconciled').length - 1).toBe(1);
  });

  test('reconcileOrphanedPrivateQueues default reason is the exact startup-recovery literal', async () => {
    const owner = await queue.add('autopilot-cycle', {});
    await claimAndComplete('autopilot-cycle', { ok: true });
    const q = `dream-inline-${Date.now()}-defreason`;
    const job = await queue.add('private-waiting', {}, {
      queue: q,
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'defreason-token',
      private_queue_lease_ms: 600_000,
    });
    await ageUpdatedAt([job.id]);

    const result = await queue.reconcileOrphanedPrivateQueues(); // NO reason opt
    expect(result.cancelled_jobs).toBe(1);
    expect((await queue.getJob(job.id))?.error_text).toBe(
      'private_queue_reconciled: startup recovery: orphaned dream-inline private queue',
    );
  });

  test('O8: a verdict flipping to live on the pre-cancel recheck cancels nothing and bumps skipped_non_orphan_queues', async () => {
    // Simulated TOCTOU race: a claim/renewal lands between the first classify
    // and the cancel. The recheck must catch it — and its non-orphan verdict
    // routes to skipped_non_orphan_queues, NOT skipped_live_queues.
    let calls = 0;
    class FlipVerdictQueue extends MinionQueue {
      override async classifyPrivateQueueForRecovery(): Promise<'orphan' | 'live' | 'unowned' | 'not_orphan'> {
        calls++;
        return calls === 1 ? 'orphan' : 'live';
      }
    }
    const flip = new FlipVerdictQueue(engine);
    const q = `dream-inline-${Date.now()}-toctou1`;
    const job = await queue.add('private-waiting', {}, {
      queue: q,
      private_queue_owner_token: 'toctou-token',
      private_queue_lease_ms: 600_000,
    });

    const result = await flip.reconcileOrphanedPrivateQueues();
    expect(calls).toBe(2);
    expect(result.cancelled_queues).toBe(0);
    expect(result.cancelled_jobs).toBe(0);
    expect(result.skipped_non_orphan_queues).toBe(1);
    expect(result.skipped_live_queues).toBe(0);
    expect((await queue.getJob(job.id))?.status).toBe('waiting');
  });

  test('O1/O3: maxQueues bounds the scan ordered by min(created_at) — only the OLDER orphan is processed', async () => {
    const older = `dream-inline-${Date.now()}-older01`;
    const newer = `dream-inline-${Date.now()}-newer01`;
    const olderJob = await queue.add('private-waiting', {}, {
      queue: older, private_queue_owner_token: 'older-token', private_queue_lease_ms: 600_000,
    });
    const newerJob = await queue.add('private-waiting', {}, {
      queue: newer, private_queue_owner_token: 'newer-token', private_queue_lease_ms: 600_000,
    });
    // Both orphan-shaped (expired lease + stale updated_at), distinct created_at.
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET private_queue_lease_until = now() - interval '1 second',
              updated_at = now() - interval '5 minutes'
        WHERE id = ANY($1::int[])`,
      [[olderJob.id, newerJob.id]],
    );
    await engine.executeRaw(
      `UPDATE minion_jobs SET created_at = now() - interval '10 minutes' WHERE id = $1`,
      [olderJob.id],
    );

    const result = await queue.reconcileOrphanedPrivateQueues({ maxQueues: 1 });
    expect(result.scanned_queues).toBe(1);
    expect(result.cancelled_queues).toBe(1);
    expect(result.cancelled_jobs).toBe(1);
    expect((await queue.getJob(olderJob.id))?.status).toBe('cancelled');
    expect((await queue.getJob(newerJob.id))?.status).toBe('waiting');
  });

  test('O4: scanned_queues counts only metadata-bearing non-terminal queues on a mixed fixture', async () => {
    const liveQ = `dream-inline-${Date.now()}-mixlive`;
    const orphanQ = `dream-inline-${Date.now()}-mixorph`;
    const legacyQ = `dream-inline-${Date.now()}-mixleg`;
    const liveJob = await queue.add('private-waiting', {}, {
      queue: liveQ, private_queue_lease_ms: 2 * 60 * 60 * 1000,
    });
    const orphanJob = await queue.add('private-waiting', {}, {
      queue: orphanQ, private_queue_owner_token: 'mix-token', private_queue_lease_ms: 1,
    });
    const legacyJob = await queue.add('legacy-private-waiting', {}, { queue: legacyQ });
    await ageUpdatedAt([liveJob.id, orphanJob.id, legacyJob.id]);

    const result = await queue.reconcileOrphanedPrivateQueues();
    expect(result.scanned_queues).toBe(2); // legacy metadata-less queue never scanned
    expect(result.skipped_live_queues).toBe(1);
    expect(result.cancelled_queues).toBe(1);
    expect(result.cancelled_jobs).toBe(1);
    expect(result.skipped_unowned_queues).toBe(0);
    expect((await queue.getJob(liveJob.id))?.status).toBe('waiting');
    expect((await queue.getJob(orphanJob.id))?.status).toBe('cancelled');
    expect((await queue.getJob(legacyJob.id))?.status).toBe('waiting');
  });

  test('O11: an orphan verdict over an all-terminal queue cancels nothing — cancelled_queues stays 0', async () => {
    // Race shape: every child terminalizes between the scan and the cancel.
    // Both classify calls say orphan, but reconcilePrivateQueue finds nothing
    // to cancel, so the cancelled_* counters must not budge.
    const q = `dream-inline-${Date.now()}-allterm`;
    const job = await queue.add('private-waiting', {}, {
      queue: q, private_queue_owner_token: 'allterm-token', private_queue_lease_ms: 600_000,
    });
    let victimCancelled = false;
    class TerminalizeOnClassifyQueue extends MinionQueue {
      override async classifyPrivateQueueForRecovery(): Promise<'orphan' | 'live' | 'unowned' | 'not_orphan'> {
        if (!victimCancelled) {
          victimCancelled = true;
          await this.cancelJob(job.id);
        }
        return 'orphan';
      }
    }
    const raced = new TerminalizeOnClassifyQueue(engine);

    const result = await raced.reconcileOrphanedPrivateQueues();
    expect(result.scanned_queues).toBe(1);
    expect(result.cancelled_queues).toBe(0);
    expect(result.cancelled_jobs).toBe(0);
    expect((await queue.getJob(job.id))?.status).toBe('cancelled'); // by the simulated race, not recovery
  });

  test('rowToMinionJob maps private-queue metadata: owner id number, token string, lease Date; missing token → null', async () => {
    const owner = await queue.add('owner-job', {});
    const q = `dream-inline-${Date.now()}-rowmap1`;
    const withToken = await queue.add('private-waiting', {}, {
      queue: q,
      private_queue_owner_job_id: owner.id,
      private_queue_owner_token: 'rowmap-token',
      private_queue_lease_ms: 600_000,
    });
    const fetched = await queue.getJob(withToken.id);
    expect(typeof fetched?.private_queue_owner_job_id).toBe('number');
    expect(fetched?.private_queue_owner_job_id).toBe(owner.id);
    expect(fetched?.private_queue_owner_token).toBe('rowmap-token');
    expect(fetched?.private_queue_lease_until).toBeInstanceOf(Date);
    expect(fetched!.private_queue_lease_until!.getTime()).toBeGreaterThan(Date.now());

    // types.ts maps the token with `|| null`, so an absent (NULL) token — and
    // by the same operator an empty string — surfaces as null, never ''.
    const q2 = `dream-inline-${Date.now()}-rowmap2`;
    const noToken = await queue.add('private-waiting', {}, {
      queue: q2,
      private_queue_owner_job_id: owner.id,
    });
    const fetched2 = await queue.getJob(noToken.id);
    expect(fetched2?.private_queue_owner_job_id).toBe(owner.id);
    expect(fetched2?.private_queue_owner_token).toBeNull();
    expect(fetched2?.private_queue_lease_until).toBeNull();
  });
});
