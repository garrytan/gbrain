import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { operationsByName } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});
afterAll(async () => { await engine.disconnect(); });

describe('cancel_job on a parent that fail_parent already failed', () => {
  test('does not report "nothing changed" while it cancels the parent\'s live child', async () => {
    const parent = await queue.add('vf-parent', {});
    const c1 = await queue.add('vf-c1', {}, { parent_job_id: parent.id, on_child_fail: 'fail_parent' });
    const c2 = await queue.add('vf-c2', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });
    const claimed = await queue.claim('tok-c1', 30_000, 'default', ['vf-c1']);
    expect(claimed?.id).toBe(c1.id);
    await queue.failJob(c1.id, 'tok-c1', 'boom', 'failed');
    expect((await queue.getJob(parent.id))?.status).toBe('failed');
    expect((await queue.getJob(c2.id))?.status).toBe('waiting');

    const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, transport: 'stdio', sourceId: 'default' } as any;
    let refused = false;
    try { await operationsByName['cancel_job'].handler(ctx, { id: parent.id }); } catch { refused = true; }
    const childAfter = (await queue.getJob(c2.id))?.status;
    expect({ refused, childAfter }).toEqual({ refused: true, childAfter: 'waiting' });
  });
});
