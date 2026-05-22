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
