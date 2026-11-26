/**
 * GST-2515: a source with sync turned off (`config.syncEnabled=false`, `gbrain sources set-sync <id> off`) kept being
 * synced by the commit notifier whenever its HEAD moved, and a run it owed (retry, or due after a restart) kept
 * restarting it. The notifier now leaves such a source unwatched and owes it nothing; explicit wanted markers (a sync
 * trigger, a webhook) still run, and turning sync back on restores the HEAD watch. Synthetic content, injected clock.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIST_EVERY_MS, RETRY_BACKOFF_MS, startCommitNotifier, type CommitNotifier, type JobStatus, type NotifierSource, type NotifierStore, type StartRequest } from '../src/core/commit-notifier.ts';
import { listHostSources } from '../src/core/notifier/resident.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { memoryNotifierStore } from './helpers/notifier-memory-store.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'source-a';
const HOST = '00000000-0000-4000-8000-0000000025a6';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const QUIET = 400;

interface World { t: number; starts: StartRequest[]; jobs: Map<string, JobStatus>; disabled: boolean }

function resident(w: World, store: NotifierStore, flag = { on: true }): CommitNotifier {
  return startCommitNotifier({
    resident: 'serve', log: () => {}, hostId: HOST, store, now: () => w.t, pollMs: 3000, quietMs: QUIET, heartbeatMs: 10_000,
    firstSliceSeconds: 30, sliceSeconds: 120, maxConcurrent: 1,
    setInterval: () => 'interval', clearInterval: () => {}, setTimeout: () => 'timer', clearTimeout: () => {},
    readFlag: async () => flag.on,
    listSources: async (): Promise<NotifierSource[]> => [{ sourceId: SOURCE, root: '/nonexistent/source-a', gitDir: null, lastCommit: A, kind: 'managed', ...(w.disabled ? { syncDisabled: true } : {}) }],
    lastCommit: async () => A, revParse: async () => B, syncRunning: () => false, drainHeld: async () => false,
    startSync: async (_s, req) => { w.starts.push(req); const jobId = 'job-' + w.starts.length; w.jobs.set(jobId, { state: 'running' }); return { jobId }; },
    jobStatus: jobId => w.jobs.get(jobId) ?? null,
  });
}
const world = (disabled: boolean): World => ({ t: 1_000_000, starts: [], jobs: new Map(), disabled });

describe('GST-2515: the commit notifier honours config.syncEnabled=false', () => {
  test('a HEAD move on a source with sync off starts nothing; turning sync back on syncs it', async () => {
    const w = world(true);
    const store = memoryNotifierStore({ lastCommit: () => A });
    const n = resident(w, store);
    await n.tick();
    for (let i = 0; i < 5; i++) { w.t += QUIET + 3000; await n.tick(); }
    expect(w.starts).toHaveLength(0);
    expect(n.snapshot().sources[0].watched).toBe(false);
    w.disabled = false;
    w.t += LIST_EVERY_MS; await n.tick();
    w.t += QUIET; await n.tick();
    expect(w.starts).toHaveLength(1);
    await n.stop();
  });

  test('a retry owed to a source with sync off never starts, but an explicit wanted marker still runs', async () => {
    const w = world(false);
    const store = memoryNotifierStore({ lastCommit: () => A });
    const n = resident(w, store);
    await n.tick();
    w.t += QUIET; await n.tick();
    expect(w.starts).toHaveLength(1);
    w.jobs.set('job-1', { state: 'done', outcome: 'resumable', reason: 'deadline', committed: false });
    w.t += QUIET; await n.tick();
    expect(store.states.get(SOURCE)).toMatchObject({ state: 'retry' });
    w.disabled = true;
    w.t += LIST_EVERY_MS; await n.tick();
    for (const wait of RETRY_BACKOFF_MS) { w.t += wait; await n.tick(); }
    expect(w.starts).toHaveLength(1);
    store.upsert(SOURCE, 'full', null);
    n.nudge();
    w.t += QUIET; await n.tick();
    w.t += QUIET; await n.tick();
    expect(w.starts).toHaveLength(2);
    await n.stop();
  });

  test('on a source with sync off an explicit request runs once, and the notifier does not retry it when it fails', async () => {
    const w = world(true);
    const store = memoryNotifierStore({ lastCommit: () => A });
    store.upsert(SOURCE, 'full', null);
    const n = resident(w, store);
    await n.tick();
    w.t += QUIET; await n.tick();
    expect(w.starts).toHaveLength(1);
    w.jobs.set('job-1', { state: 'error', error: 'boom' });
    w.t += QUIET; await n.tick();
    for (const wait of [...RETRY_BACKOFF_MS, RETRY_BACKOFF_MS.at(-1)!]) { w.t += wait; await n.tick(); }
    expect(w.starts).toHaveLength(1);
    store.upsert(SOURCE, 'full', null);
    n.nudge();
    w.t += QUIET; await n.tick();
    w.t += QUIET; await n.tick();
    expect(w.starts).toHaveLength(2);
    await n.stop();
  });

  test('turning sync off drops the retry an already-unwatched source owed: turning it back on starts nothing', async () => {
    const w = world(false);
    const store = memoryNotifierStore({ lastCommit: () => A });
    store.upsert(SOURCE, 'freshness', B);
    const n = resident(w, store, { on: false });
    await n.tick();
    expect(w.starts).toHaveLength(1);
    w.jobs.set('job-1', { state: 'done', outcome: 'resumable', reason: 'deadline', committed: false });
    store.markers.clear();
    w.t += QUIET; await n.tick();
    expect(store.states.get(SOURCE)).toMatchObject({ state: 'retry' });
    w.disabled = true;
    w.t += LIST_EVERY_MS; await n.tick();
    w.t += QUIET; await n.tick();
    expect(w.starts).toHaveLength(1);
    expect(store.states.get(SOURCE)).toMatchObject({ state: 'idle' });
    w.disabled = false;
    w.t += LIST_EVERY_MS; await n.tick();
    for (const wait of RETRY_BACKOFF_MS) { w.t += wait; await n.tick(); }
    expect(w.starts).toHaveLength(1);
    await n.stop();
  });
});

const arms: Array<[string, string | undefined]> = [['pglite', undefined], ...(process.env.DATABASE_URL ? [['postgres', process.env.DATABASE_URL] as [string, string]] : [])];

describe.each(arms)('GST-2515: listHostSources marks a source with sync off (%s)', (_arm, databaseUrl) => {
  test('config.syncEnabled=false lists the source as syncDisabled; on or unset does not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gst2515-notifier-'));
    execFileSync('git', ['init', '-q', root]);
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    const ids = ['source-off', 'source-on', 'source-unset'];
    try {
      const configs = ['{"syncEnabled":false}', '{"syncEnabled":true}', '{}'];
      for (const [i, id] of ids.entries()) {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config', [id, root, configs[i]]);
      }
      const { sources } = await listHostSources(engine, HOST, { GBRAIN_NOTIFIER_CLASSIC_SOURCES: ids.join(',') });
      const byId = new Map(sources.map(s => [s.sourceId, s]));
      expect(byId.get('source-off')?.syncDisabled).toBe(true);
      expect(byId.get('source-on')?.syncDisabled).toBeUndefined();
      expect(byId.get('source-unset')?.syncDisabled).toBeUndefined();

      if (process.platform !== 'win32') {
        const emptyPath = join(root, 'empty-path');
        mkdirSync(emptyPath);
        await withEnv({ PATH: emptyPath }, async () => {
          const unavailable = await listHostSources(engine, HOST, { GBRAIN_NOTIFIER_CLASSIC_SOURCES: ids.join(',') });
          expect(unavailable.sources.filter(source => ids.includes(source.sourceId))).toEqual([]);
          expect(unavailable.skipped.filter(source => ids.includes(source.sourceId))).toEqual(
            ids.map(sourceId => ({ sourceId, reason: `${root}: Git executable unavailable on this host` })),
          );
        });
      }
    } finally {
      for (const id of ids) await engine.executeRaw('DELETE FROM sources WHERE id = $1', [id]).catch(() => undefined);
      await close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
