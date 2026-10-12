/**
 * Fix wave 15 P4.2 (supersedes PR #6465 by @mattverlaque, whose diagnosis and fail-first test this follows): a brain
 * whose source is a gbrain-owned content directory (`gbrain init`, no Git checkout) had autopilot's freshness loop queue
 * a `sync` job for it every slot; performSync refused it (`sync_not_applicable`), never stamped `last_sync_at`, the job
 * went dead and the next slot queued it again, forever. One `automaticSyncSkip` predicate now decides automatic sync for
 * the freshness loop, the full-cycle fan-out and `sync --all`; the reason is stated once per source and reason; and a
 * job an older daemon already queued completes as a skip instead of dying.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { dispatchPerSource } from '../src/commands/autopilot-fanout.ts';
import { SOURCE_FRESHNESS_PHASES } from '../src/core/cycle.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import { automaticSyncSkip, reportAutomaticSyncSkip } from '../src/core/sync-policy.ts';

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
  home = mkdtempSync(join(tmpdir(), 'gbrain-6465-'));
});

const inHome = <T,>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const addSource = (id: string, localPath: string, config: Record<string, unknown> = {}) =>
  engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, localPath, JSON.stringify(config)]);
function ownedContentDir(sourceId: string): string {
  const dir = join(home, '.gbrain', 'content', 'brain-example', sourceId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function checkout(name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
}
const queued = () => engine.executeRaw<{ name: string; data: Record<string, unknown> }>('SELECT name, data FROM minion_jobs ORDER BY id');

async function freshnessTick(): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  (process.stderr as { write: unknown }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
  console.log = () => {};
  try {
    await dispatchFreshnessSyncs(engine, new MinionQueue(engine), { baseInterval: 60, slot: `slot-${Math.random()}`, timeoutMs: 60_000, jsonMode: true });
  } finally {
    (process.stderr as { write: unknown }).write = write;
    console.log = log;
  }
  return lines.flatMap(l => l.split('\n')).filter(Boolean);
}

describe('automaticSyncSkip (one predicate for automatic sync)', () => {
  test('a content directory is sync_not_applicable; a checkout, or the same directory after git init, is not skipped', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    const skip = await automaticSyncSkip(engine, { id: 'notes-example', local_path: dir, config: {} });
    expect(skip).toMatchObject({ reason: 'sync_not_applicable' });
    expect(skip!.message).toContain('gbrain import <dir> --source notes-example');
    const repo = checkout('repo-example');
    await addSource('repo-example', repo);
    expect(await automaticSyncSkip(engine, { id: 'repo-example', local_path: repo, config: {} })).toBeNull();
    execFileSync('git', ['-C', dir, 'init', '-q']);
    expect(await automaticSyncSkip(engine, { id: 'notes-example', local_path: dir, config: {} })).toBeNull();
  }));

  test('disabled config and a pending activation come first, in that order, and are the same reasons the dispatchers already used', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir, { syncEnabled: false });
    expect(await automaticSyncSkip(engine, { id: 'notes-example', local_path: dir, config: { syncEnabled: false } }, new Set(['notes-example']))).toMatchObject({ reason: 'sync_disabled' });
    expect(await automaticSyncSkip(engine, { id: 'notes-example', local_path: dir, config: {} }, new Set(['notes-example']))).toMatchObject({ reason: 'activation_pending' });
  }));

  test('the latch states a reason once per source, again when it changes, and again after the source ran in between', () => {
    const lines: string[] = [];
    const latch = new Map();
    const say = (skip: Parameters<typeof reportAutomaticSyncSkip>[1]) => reportAutomaticSyncSkip('s-example', skip, 'x_skipped', true, l => lines.push(l), latch);
    say({ reason: 'sync_not_applicable', message: 'm' }); say({ reason: 'sync_not_applicable', message: 'm' });
    say({ reason: 'activation_pending', message: 'm' });
    say(null); say({ reason: 'activation_pending', message: 'm' });
    expect(lines.map(l => JSON.parse(l).reason)).toEqual(['sync_not_applicable', 'activation_pending', 'activation_pending']);
  });
});

describe('autopilot on a brain whose source is a gbrain-owned content directory', () => {
  test('the freshness loop queues no sync job for it, states the reason once across ticks, and still dispatches a checkout beside it', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    const repo = checkout('repo-example');
    await addSource('repo-example', repo);
    const first = await freshnessTick();
    const second = await freshnessTick();
    const jobs = await queued();
    // The checkout's two ticks coalesce on the waiting job (maxWaiting: 1); the content directory gets none.
    expect(jobs.map(j => [j.name, j.data.sourceId])).toEqual([['sync', 'repo-example']]);
    const skips = [...first, ...second].map(l => JSON.parse(l)).filter(e => e.event === 'freshness_sync_skipped');
    expect(skips).toEqual([{ event: 'freshness_sync_skipped', source_id: 'notes-example', reason: 'sync_not_applicable' }]);
  }));

  test('after the user runs git init there, the next tick dispatches it', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    await freshnessTick();
    expect(await queued()).toEqual([]);
    execFileSync('git', ['-C', dir, 'init', '-q']);
    await freshnessTick();
    expect((await queued()).map(j => [j.name, j.data.sourceId])).toEqual([['sync', 'notes-example']]);
  }));

  test('the full-cycle fan-out drops the sync phase for it (same predicate), with one fanout_sync_skipped event', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    const events: string[] = [];
    const opts = { repoPath: dir, slot: 's', timeoutMs: 60_000, fanoutMax: 10, jsonMode: true, emit: (line: string) => events.push(line), log: () => {} };
    await dispatchPerSource(engine, new MinionQueue(engine), opts);
    await dispatchPerSource(engine, new MinionQueue(engine), { ...opts, slot: 's2' });
    const cycles = (await queued()).filter(j => j.name === 'autopilot-cycle');
    expect(cycles).toHaveLength(1);
    for (const job of cycles) {
      expect(job.data.phases).toEqual(SOURCE_FRESHNESS_PHASES.filter(p => p !== 'sync'));
      expect(job.data.pull).toBe(false);
    }
    expect(events.map(e => JSON.parse(e)).filter(e => e.event === 'fanout_sync_skipped'))
      .toEqual([{ event: 'fanout_sync_skipped', source_id: 'notes-example', reason: 'sync_not_applicable' }]);
  }));

  test('a sync job an older daemon already queued for it completes as a skip instead of a dead job', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    const logged: string[] = [];
    const error = console.error;
    console.error = (line: unknown) => { logged.push(String(line)); };
    let result: unknown;
    try {
      result = await makeSyncHandler(engine)({ id: 1, name: 'sync', data: { sourceId: 'notes-example', repoPath: dir, pull: false, auto_embed_backfill: true, embed_reason: 'autopilot_freshness' },
        signal: new AbortController().signal, updateProgress: async () => {}, log: async () => {} } as never);
    } finally { console.error = error; }
    expect(result).toEqual({ skipped: true, reason: 'sync_not_applicable', source_id: 'notes-example' });
    expect(logged.some(l => l.includes('[sync] skipped: sync does not apply to notes-example'))).toBe(true);
    expect(await queued()).toEqual([]);
  }));
});
