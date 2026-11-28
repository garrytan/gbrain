/** #10484: a database-backed source with no local_path and no connector kind (the transcript archive) still gets its auto-drain. */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { submitAutoDrains } from '../src/commands/autopilot-dispatch.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.setConfig('autopilot.auto_drain.threshold', '1');
});

const prose = (n: string) => `A durable decision about ${n}, recorded in prose with context. `.repeat(12);

test('a backlogged source with no local_path is submitted without repoPath', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('conversations','conversations','{\"federated\": true}'::jsonb)");
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`articles/conv-${i}`, { type: 'article', title: `conv ${i}`, compiled_truth: prose(`conv ${i}`) } as never, { sourceId: 'conversations' });
  }
  await submitAutoDrains(engine, queue, { timeoutMs: 60_000, jsonMode: true, now: () => Date.parse('2026-10-05T12:00:00Z') });
  const jobs = await engine.executeRaw<{ source: string; repo: string | null }>(
    "SELECT data->>'sourceId' AS source, data->>'repoPath' AS repo FROM minion_jobs WHERE name = 'extract-atoms-drain'");
  expect(jobs).toEqual([{ source: 'conversations', repo: null }]);
});
