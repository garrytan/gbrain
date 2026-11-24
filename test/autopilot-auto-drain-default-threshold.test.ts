/** Default autopilot.auto_drain.threshold matches Doctor's extract_atoms_backlog (10, strict greater-than). */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { submitAutoDrains } from '../src/commands/autopilot-dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let home: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'autopilot.auto_drain.%' OR key LIKE 'cycle.extract_atoms.%'");
  home = mkdtempSync(join(tmpdir(), 'gbrain-auto-drain-thr-'));
});

const prose = (n: string) => `A durable decision about ${n}, recorded in prose with context. `.repeat(12);

async function gitSource(id: string, pages: number): Promise<void> {
  const root = join(home, id);
  mkdirSync(root, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  for (let i = 0; i < pages; i++) {
    await engine.putPage(`notes/${id}-${i}`, { type: 'note', title: `${id} ${i}`, compiled_truth: prose(`${id} ${i}`) } as never, { sourceId: id });
  }
}

async function queuedSources(): Promise<string[]> {
  await withEnv({ GBRAIN_HOME: home }, () =>
    submitAutoDrains(engine, queue, { timeoutMs: 60_000, jsonMode: true, now: () => Date.parse('2026-09-20T12:00:00Z') }));
  const rows = await engine.executeRaw<{ source: string }>(
    "SELECT data->>'sourceId' AS source FROM minion_jobs WHERE name='extract-atoms-drain' ORDER BY id");
  return rows.map(r => r.source);
}

test('default threshold: 10 pending pages are not queued', async () => {
  await gitSource('ten', 10);
  expect(await queuedSources()).toEqual([]);
  rmSync(home, { recursive: true, force: true });
});

test('default threshold: 11 pending pages are queued', async () => {
  await gitSource('eleven', 11);
  expect(await queuedSources()).toEqual(['eleven']);
  rmSync(home, { recursive: true, force: true });
});

test('explicit override of 25 keeps 25 unqueued and queues 26', async () => {
  await engine.setConfig('autopilot.auto_drain.threshold', '25');
  await gitSource('t25', 25);
  expect(await queuedSources()).toEqual([]);
  await gitSource('t26', 26);
  expect(await queuedSources()).toEqual(['t26']);
  rmSync(home, { recursive: true, force: true });
});
