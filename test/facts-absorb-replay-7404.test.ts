/**
 * Completed facts absorption must refuse replay before scheduling new work.
 * Removing the guard queues fresh extraction, including with changed inputs.
 * Generic queue replay tests cover copying jobs, not this zero-model boundary.
 * Uses the real queue lifecycle and an isolated in-memory engine; no new seam.
 * This tests refusal, not successful replay of a managed-facts batch.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => { await engine?.disconnect(); });

test('completed facts absorption refuses unchanged and changed replay without queue mutations', async () => {
  const job = await queue.add('facts-absorb', {
    slug: 'notes/example', sourceId: 'default', sessionId: 'example-session',
    persistence_request_id: '00000000-0000-4000-8000-000000000001',
  }, {}, { allowProtectedSubmit: true });
  expect((await queue.claim('facts-token', 30_000, 'default', ['facts-absorb']))?.id).toBe(job.id);
  await queue.completeJob(job.id, 'facts-token', { inserted: 1, fact_ids: [17] });
  const before = await queue.getJob(job.id);
  const rowsBefore = await engine.executeRaw('SELECT * FROM minion_jobs ORDER BY id');

  for (const overrides of [undefined, {}, { sourceId: 'other' }, { sessionId: 'other' },
    { persistence_request_id: null }, { model: 'example:other' }]) {
    await expect(queue.replayJob(job.id, overrides)).rejects.toThrow('zero-model guarantee');
    expect(await queue.getJob(job.id)).toEqual(before);
    expect(await engine.executeRaw('SELECT * FROM minion_jobs ORDER BY id')).toEqual(rowsBefore);
  }
  // No replay was admitted for a worker to extract or embed.
  expect(await queue.claim('replay-token', 30_000, 'default', ['facts-absorb'])).toBeNull();
});

test('completed unrelated jobs retain ordinary replay', async () => {
  const job = await queue.add('research', { topic: 'example' });
  expect((await queue.claim('research-token', 30_000, 'default', ['research']))?.id).toBe(job.id);
  await queue.completeJob(job.id, 'research-token', { result: 'done' });
  const replay = await queue.replayJob(job.id);
  expect(replay?.status).toBe('waiting');
  expect(replay?.id).not.toBe(job.id);
  expect(replay?.data).toEqual(job.data);
});
