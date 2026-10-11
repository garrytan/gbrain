/**
 * Autopilot freshness never dispatches `sync` for a source where sync does not
 * apply (a gbrain-owned content directory, not a Git checkout).
 *
 * Protects: a managed brain's `default` source. performSync refuses it with
 * `sync_not_applicable` and never stamps last_sync_at, so the freshness loop
 * re-dispatched it every slot and the job died every time (attempt 2 -> dead).
 * Fails when: the freshness loop stops using the same applicability check
 * `sync --all` uses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
  home = mkdtempSync(join(tmpdir(), 'gbrain-freshness-na-'));
});

const addSource = (id: string, localPath: string) =>
  engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, localPath]);
const queued = () => engine.executeRaw<{ name: string; data: Record<string, unknown> }>('SELECT name, data FROM minion_jobs ORDER BY id');

async function freshness(): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  (process.stderr as { write: unknown }).write = (chunk: string) => { lines.push(String(chunk).trim()); return true; };
  console.log = () => {};
  try {
    await withEnv({ GBRAIN_HOME: home }, () =>
      dispatchFreshnessSyncs(engine, new MinionQueue(engine), { baseInterval: 60, slot: `slot-${Math.random()}`, timeoutMs: 60_000, jsonMode: true }));
  } finally {
    (process.stderr as { write: unknown }).write = write;
    console.log = log;
  }
  return lines;
}

describe('freshness dispatch and sync applicability', () => {
  test('a gbrain-owned content directory gets no sync job, and one notice per process', async () => {
    const owned = join(home, '.gbrain', 'content', 'brain-example', 'notes-example');
    mkdirSync(owned, { recursive: true });
    await addSource('notes-example', owned);

    const first = await freshness();
    const second = await freshness();
    expect(await queued()).toEqual([]);
    const notices = [...first, ...second].filter(l => l.includes('freshness_sync_not_applicable')).map(l => JSON.parse(l));
    expect(notices).toEqual([{ event: 'freshness_sync_not_applicable', source_id: 'notes-example' }]);
  });

  test('a Git checkout next to it is still dispatched', async () => {
    const owned = join(home, '.gbrain', 'content', 'brain-example', 'notes-example');
    mkdirSync(owned, { recursive: true });
    await addSource('notes-example', owned);
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-freshness-repo-'));
    mkdirSync(join(repo, '.git'));
    await addSource('repo-example', repo);

    await freshness();
    const jobs = await queued();
    expect(jobs.map(j => [j.name, j.data.sourceId])).toEqual([['sync', 'repo-example']]);
    rmSync(repo, { recursive: true, force: true });
  });

  test('the same directory after the user ran git init is dispatched again', async () => {
    const owned = join(home, '.gbrain', 'content', 'brain-example', 'later-example');
    mkdirSync(join(owned, '.git'), { recursive: true });
    await addSource('later-example', owned);

    await freshness();
    expect((await queued()).map(j => j.data.sourceId)).toEqual(['later-example']);
  });
});
