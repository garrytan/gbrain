import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
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
afterAll(async () => { await engine.disconnect(); });

describe('add with parent_job_id of a finished parent', () => {
  test('refuses a child under a cancelled parent instead of queueing work nothing waits for', async () => {
    const parent = await queue.add('vf-aggregator', {});
    expect(await queue.cancelJob(parent.id)).not.toBeNull();
    let added: number | null = null;
    try { added = (await queue.add('vf-late-child', {}, { parent_job_id: parent.id, on_child_fail: 'continue' })).id; } catch { /* refused */ }
    const runnable = added === null ? 0 : (await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM minion_jobs WHERE id = $1 AND status IN ('waiting','delayed')`, [added]))[0]!.n;
    expect(runnable).toBe(0);
  });
});
