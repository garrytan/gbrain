/**
 * GST-2515: retries of a large source that never finish and never come back.
 *   - A resident restart (or a new lease owner) made every retry the "first" start of that process, so each one got the
 *     short first slice and stopped at the same point having committed nothing. The first slice is now only for a
 *     source whose durable attempt count is zero: a retry after an attempt that advanced nothing never gets it again.
 *   - With sync.on_commit off nothing reads the source's HEAD, so a run was due only while a wanted marker existed. A
 *     run's own marker settle can clear that marker after a resumable stop, which left the source in retry /
 *     notifier_stalled with no retry ever starting and nothing logged. A retry (or a resume) the notifier owes now keeps
 *     an unwatched source due on its tier, with no marker and across restarts and owner changes.
 * The in-memory store covers the scheduling rules; the real SQL store (PGLite always, Postgres when DATABASE_URL is
 * set) covers the durable round trip a restarted resident reads. Synthetic content only, injected clock.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { FLAG_EVERY_MS, RETRY_BACKOFF_MS, startCommitNotifier, type CommitNotifier, type JobStatus, type NotifierStore, type StartRequest } from '../src/core/commit-notifier.ts';
import { readNotifierSources, settleMarkers, upsertMarker } from '../src/core/notifier/store.ts';
import { sqlNotifierStore } from '../src/core/notifier/resident.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { memoryNotifierStore, type MemoryLeases } from './helpers/notifier-memory-store.ts';

const SOURCE = 'source-a';
const HOST = '00000000-0000-4000-8000-0000000025a5';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const QUIET = 400;

interface World { t: number; starts: StartRequest[]; jobs: Map<string, JobStatus> }

function resident(w: World, store: NotifierStore, kind: 'serve' | 'jobs-worker' = 'serve', flag = { on: false }): CommitNotifier {
  return startCommitNotifier({
    resident: kind, log: () => {}, hostId: HOST, store, now: () => w.t, pollMs: 3000, quietMs: QUIET, heartbeatMs: 10_000,
    firstSliceSeconds: 30, sliceSeconds: 120, maxConcurrent: 1,
    setInterval: () => 'interval', clearInterval: () => {}, setTimeout: () => 'timer', clearTimeout: () => {},
    readFlag: async () => flag.on,
    listSources: async () => [{ sourceId: SOURCE, root: '/nonexistent/source-a', gitDir: null, lastCommit: A, kind: 'managed' }],
    lastCommit: async () => A, revParse: async () => B, syncRunning: () => false, drainHeld: async () => false,
    startSync: async (_s, req) => { w.starts.push(req); const jobId = 'job-' + w.starts.length; w.jobs.set(jobId, { state: 'running' }); return { jobId }; },
    jobStatus: jobId => w.jobs.get(jobId) ?? null,
  });
}
/** The last start's job stops resumable at its deadline having committed nothing; clear then drops the marker, as the run's own settle does. */
async function stallLast(w: World, n: CommitNotifier, clear: () => Promise<void> | void = () => {}) {
  w.jobs.set('job-' + w.starts.length, { state: 'done', outcome: 'resumable', reason: 'deadline', committed: false });
  await clear();
  w.t += QUIET; await n.tick();
}
const slices = (w: World) => w.starts.map(s => s.sliceSeconds);

describe('GST-2515: an unwatched source keeps its retry tier (in-memory store)', () => {
  test('a marker-driven run that stopped without advancing is retried on every tier after its marker is gone', async () => {
    const w: World = { t: 1_000_000, starts: [], jobs: new Map() };
    const store = memoryNotifierStore({ lastCommit: () => A });
    store.upsert(SOURCE, 'freshness', B);
    const n = resident(w, store);
    await n.tick();
    expect(w.starts).toHaveLength(1);
    for (const wait of [...RETRY_BACKOFF_MS, RETRY_BACKOFF_MS.at(-1)!]) {
      await stallLast(w, n, () => { store.markers.clear(); });
      w.t += wait; await n.tick();
    }
    expect(w.starts).toHaveLength(1 + RETRY_BACKOFF_MS.length + 1);
    expect(n.decisions.filter(d => d.decision === 'stalled').length).toBeGreaterThan(0);
    expect(slices(w)).toEqual([30, ...Array(RETRY_BACKOFF_MS.length + 1).fill(null)]);
    await n.stop();
  });

  test('a restarted resident retries a stalled source after next_retry_at, without the first slice', async () => {
    const w: World = { t: 1_000_000, starts: [], jobs: new Map() };
    const store = memoryNotifierStore({ lastCommit: () => A });
    store.upsert(SOURCE, 'freshness', B);
    const first = resident(w, store);
    await first.tick();
    await stallLast(w, first, () => { store.markers.clear(); });
    await first.stop();
    expect(store.states.get(SOURCE)).toMatchObject({ state: 'retry', attempts: 1 });
    const next = resident(w, store);
    await next.tick();
    expect(w.starts).toHaveLength(1);
    w.t += RETRY_BACKOFF_MS[0]; await next.tick();
    expect(slices(w)).toEqual([30, null]);
    await next.stop();
  });

  test('a standby that takes the lease over reads the attempts its predecessor recorded: no first slice', async () => {
    const w: World = { t: 1_000_000, starts: [], jobs: new Map() };
    const leases: MemoryLeases = { rows: new Map(), now: () => w.t };
    const store = memoryNotifierStore({ lastCommit: () => A, leases });
    store.upsert(SOURCE, 'freshness', B);
    const owner = resident(w, store, 'serve');
    await owner.tick();
    const standby = resident(w, store, 'jobs-worker');
    await standby.tick();
    expect([owner.owner, standby.owner]).toEqual([true, false]);
    await stallLast(w, owner);
    await owner.stop();
    w.t += RETRY_BACKOFF_MS[0] + 10_000; await standby.tick();
    expect(standby.owner).toBe(true);
    expect(slices(w)).toEqual([30, null]);
    await standby.stop();
  });

  test('turning sync.on_commit off stops a retry that a HEAD move started: the source goes idle and nothing more starts', async () => {
    const w: World = { t: 1_000_000, starts: [], jobs: new Map() };
    const store = memoryNotifierStore({ lastCommit: () => A });
    const flag = { on: true };
    const n = resident(w, store, 'serve', flag);
    await n.tick();
    w.t += QUIET; await n.tick();
    expect(w.starts).toHaveLength(1);
    await stallLast(w, n);
    expect(store.states.get(SOURCE)).toMatchObject({ state: 'retry' });
    flag.on = false;
    w.t += FLAG_EVERY_MS; await n.tick();
    for (const wait of RETRY_BACKOFF_MS) { w.t += wait; await n.tick(); }
    expect(w.starts).toHaveLength(1);
    expect(store.states.get(SOURCE)).toMatchObject({ state: 'idle' });
    await n.stop();
  });

  test('a run that completes clears the owed retry: the source goes idle and nothing more starts', async () => {
    const w: World = { t: 1_000_000, starts: [], jobs: new Map() };
    const store = memoryNotifierStore({ lastCommit: () => A });
    store.upsert(SOURCE, 'freshness', B);
    const n = resident(w, store);
    await n.tick();
    await stallLast(w, n, () => { store.markers.clear(); });
    w.t += RETRY_BACKOFF_MS[0]; await n.tick();
    w.jobs.set('job-2', { state: 'done', outcome: 'synced' });
    w.t += QUIET; await n.tick();
    w.t += RETRY_BACKOFF_MS.at(-1)!; await n.tick();
    expect(w.starts).toHaveLength(2);
    expect(store.states.get(SOURCE)).toMatchObject({ state: 'idle', attempts: 0 });
    await n.stop();
  });
});

const arms: Array<[string, string | undefined]> = [['pglite', undefined], ...(process.env.DATABASE_URL ? [['postgres', process.env.DATABASE_URL] as [string, string]] : [])];

describe.each(arms)('GST-2515: a restarted resident and the durable notifier row (%s)', (_arm, databaseUrl) => {
  async function brain(run: (engine: BrainEngine) => Promise<void>) {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.executeRaw('DELETE FROM sync_notifier_leases WHERE host_id = $1', [HOST]);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config,last_commit) VALUES($1,$1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET last_commit = EXCLUDED.last_commit', [SOURCE, '/nonexistent/source-a', '{}', A]);
      await run(engine);
    } finally {
      await engine.executeRaw('DELETE FROM sync_notifier_leases WHERE host_id = $1', [HOST]).catch(() => undefined);
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE]).catch(() => undefined);
      await close();
    }
  }

  test('the marker still due: the retry in the next resident runs without the first slice', async () => {
    await brain(async engine => {
      const w: World = { t: 1_000_000, starts: [], jobs: new Map() };
      await upsertMarker(engine, { sourceId: SOURCE, intent: 'freshness', wantedHead: B, requestedBy: 'sync_nudge' });
      const first = resident(w, sqlNotifierStore(engine));
      await first.tick();
      await stallLast(w, first);
      await first.stop();
      expect((await readNotifierSources(engine, [SOURCE]))[0]).toMatchObject({ state: 'retry', attempts: 1 });
      const next = resident(w, sqlNotifierStore(engine), 'jobs-worker');
      await next.tick();
      expect(w.starts).toHaveLength(1);
      w.t += RETRY_BACKOFF_MS[0] + 1000; await next.tick();
      expect(slices(w)).toEqual([30, null]);
      await next.stop();
    });
  }, 120_000);

  test('the marker settled by the stopped run: the next resident still retries the source', async () => {
    await brain(async engine => {
      const w: World = { t: 1_000_000, starts: [], jobs: new Map() };
      const marker = await upsertMarker(engine, { sourceId: SOURCE, intent: 'freshness', wantedHead: B, requestedBy: 'sync_nudge' });
      const first = resident(w, sqlNotifierStore(engine));
      await first.tick();
      // The run's settle: the checkout's HEAD equals last_commit, so the marker reads as satisfied though the run stopped resumable.
      await stallLast(w, first, async () => { expect(await settleMarkers(engine, SOURCE, [marker], { pulled: false, full: false, checkoutHead: A })).toEqual([]); });
      await first.stop();
      expect((await readNotifierSources(engine, [SOURCE]))[0]).toMatchObject({ state: 'retry', attempts: 1 });
      const next = resident(w, sqlNotifierStore(engine), 'jobs-worker');
      await next.tick();
      expect(w.starts).toHaveLength(1);
      w.t += RETRY_BACKOFF_MS[0] + 1000; await next.tick();
      expect(slices(w)).toEqual([30, null]);
      await next.stop();
    });
  }, 120_000);
});
