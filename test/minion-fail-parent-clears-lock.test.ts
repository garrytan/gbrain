import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { formatJobDetail } from '../src/commands/jobs/shared.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});
afterAll(async () => { await engine.disconnect(); });

describe('fail_parent on a parent that added its child while active', () => {
  test('the failed parent holds no lock, and jobs get shows none', async () => {
    const parent = await queue.add('vf-lock-parent', {});
    expect((await queue.claim('tok-parent', 60_000, 'default', ['vf-lock-parent']))?.id).toBe(parent.id);
    const child = await queue.add('vf-lock-child', {}, { parent_job_id: parent.id, on_child_fail: 'fail_parent' });
    expect((await queue.claim('tok-child', 60_000, 'default', ['vf-lock-child']))?.id).toBe(child.id);
    await queue.failJob(child.id, 'tok-child', 'boom', 'failed');
    const row = await queue.getJob(parent.id);
    expect(row?.status).toBe('failed');
    expect(row?.lock_token).toBeNull();
    expect(formatJobDetail(row!)).not.toContain('Lock: tok-parent');
  });
});
