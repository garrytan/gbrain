/**
 * GBRA-133 PR 2a.4 (latency finding 6.7): autopilot dispatched a freshness sync only when last_sync_at was older than
 * its interval (autopilot-dispatch.ts), checked once per cycle of 150 to 600 s, so a commit made right after a sync
 * waited for the next slot: Phase 1 measured up to 430 s per commit on Postgres without a serve.
 *
 * Protects: the freshness loop is HEAD-driven. A checkout whose HEAD differs from the source's last synced commit gets
 * one sync job at the next tick (keyed on the HEAD, so a completed job in the same slot never swallows a new commit),
 * classic and managed alike; the same HEAD is dispatched once; a HEAD in the middle of a rebase waits for it to finish;
 * the wall-clock rule stays the backstop. With sync.on_commit on, the daemon's wait between ticks reads HEADs every few
 * seconds and dispatches the moved source without waiting for the tick; with it off the wait reads nothing.
 * Fails when: a fresh-by-clock source with a new commit gets no job, a HEAD is dispatched twice, a mid-rebase HEAD is
 * synced, or the between-tick probe misses a commit. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { makeSyncHandler } from '../../src/core/minions/handlers/sync.ts';
import { dispatchFreshnessSyncs } from '../../src/commands/autopilot-dispatch.ts';
import { pathologicalArms } from './harness.ts';
import { md, withProbeEngine, withProbeRepo, type ProbeRepo, type SyncMode } from './s-blockers-fixture.ts';

interface QueuedSync { id: number; status: string; idempotency_key: string | null }
const syncJobs = (engine: BrainEngine, sourceId: string) => engine.executeRaw<QueuedSync>(
  "SELECT id, status, idempotency_key FROM minion_jobs WHERE name='sync' AND data->>'sourceId'=$1 ORDER BY id", [sourceId]);

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  (process.stderr as { write: unknown }).write = () => true;
  console.log = () => {};
  try { return await run(); } finally { (process.stderr as { write: unknown }).write = write; console.log = log; }
}

const tick = (engine: BrainEngine, freshnessHeads = new Map<string, string>(), baseInterval = 300) => quietly(() => dispatchFreshnessSyncs(engine, new MinionQueue(engine),
  { baseInterval, slot: '2026-10-18T00:00:00.000Z', timeoutMs: 120_000, jsonMode: true, freshnessHeads } as Parameters<typeof dispatchFreshnessSyncs>[2]));

async function runQueued(engine: BrainEngine, jobId: number): Promise<string | undefined> {
  const queue = new MinionQueue(engine);
  const worker = new MinionWorker(engine, { pollInterval: 25, concurrency: 1 });
  worker.register('sync', makeSyncHandler(engine));
  const running = worker.start();
  try {
    for (let i = 0; i < 4_800; i++) {
      const status = (await queue.getJob(jobId))?.status;
      if (status === 'completed' || status === 'failed' || status === 'dead') return status;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { worker.stop(); await running; }
  return (await queue.getJob(jobId))?.status;
}

/** A synced source (last_commit = HEAD, last_sync_at = now), then one more commit nothing has synced. */
async function syncedThenCommitted(r: ProbeRepo, name: string): Promise<string> {
  await r.sync();
  expect(await r.lastCommit()).toBe(r.head());
  r.write(name + '.md', md(name)); r.commitAll(name);
  return r.head();
}

const live = async (r: ProbeRepo, slug: string) =>
  (await r.engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [r.sourceId, slug])).length > 0;

for (const { backend, databaseUrl } of pathologicalArms()) {
  for (const mode of ['classic', 'managed'] as SyncMode[]) {
    const withRepo = (run: (r: ProbeRepo) => Promise<void>) => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, mode, home, run));

    describe('autopilot freshness is HEAD-driven (' + backend + ', ' + mode + ')', () => {
      test('a commit right after a sync gets one sync job at the next tick, keyed on its HEAD, and the job makes it visible', async () => {
        await withRepo(async r => {
          const head = await syncedThenCommitted(r, 'after-sync');
          await tick(r.engine);
          const jobs = await syncJobs(r.engine, r.sourceId);
          expect(jobs.map(j => j.idempotency_key)).toEqual(['autopilot-sync:' + r.sourceId + ':head:' + head]);
          expect(await runQueued(r.engine, jobs[0]!.id)).toBe('completed');
          expect(await r.lastCommit()).toBe(head);
          expect(await live(r, 'after-sync')).toBe(true);
        });
      }, 240_000);

      test('the same HEAD is dispatched once: a second tick adds nothing, and a restarted daemon coalesces onto the same job', async () => {
        await withRepo(async r => {
          await syncedThenCommitted(r, 'once');
          const heads = new Map<string, string>();
          await tick(r.engine, heads);
          await tick(r.engine, heads);
          const restarted = await tick(r.engine);
          expect((await syncJobs(r.engine, r.sourceId)).length).toBe(1);
          expect(restarted.find(d => d.source_id === r.sourceId)?.outcome).toBe('coalesced');
        });
      }, 240_000);

      test('a HEAD in the middle of a rebase waits; once the rebase is gone the next tick dispatches it', async () => {
        await withRepo(async r => {
          const head = await syncedThenCommitted(r, 'mid-rebase');
          const marker = join(r.root, '.git', 'rebase-merge');
          mkdirSync(marker);
          await tick(r.engine);
          expect(await syncJobs(r.engine, r.sourceId)).toEqual([]);
          rmSync(marker, { recursive: true, force: true });
          await tick(r.engine);
          expect((await syncJobs(r.engine, r.sourceId)).map(j => j.idempotency_key)).toEqual(['autopilot-sync:' + r.sourceId + ':head:' + head]);
        });
      }, 240_000);

      test('the wall-clock rule stays the backstop: a synced HEAD whose last sync is older than the interval is dispatched on the slot key', async () => {
        await withRepo(async r => {
          await r.sync();
          await tick(r.engine);
          expect(await syncJobs(r.engine, r.sourceId)).toEqual([]);
          await tick(r.engine, new Map(), 0.001);
          expect((await syncJobs(r.engine, r.sourceId)).map(j => j.idempotency_key)).toEqual(['autopilot-sync:' + r.sourceId + ':2026-10-18T00:00:00.000Z']);
        });
      }, 240_000);

      test('between ticks, with sync.on_commit on, the HEAD probe dispatches a new commit at its first pass; with it off, or while a resident notifier runs in the process, nothing is read', async () => {
        const { sleepWatchingHeads } = await import('../../src/commands/autopilot-dispatch.ts');
        await withRepo(async r => {
          const head = await syncedThenCommitted(r, 'between-ticks');
          let clock = 1_000_000;
          let reads = 0;
          const deps = {
            env: { GBRAIN_AUTOPILOT_HEAD_PROBE_MS: '3000' }, now: () => clock,
            sleep: async (ms: number) => { clock += ms; },
            readHead: async (root: string) => { reads++; return (await import('../../src/core/checkout-head.ts')).readCheckoutHead(root); },
          };
          const state = { stopping: false, freshnessHeads: new Map<string, string>() };
          const off = await quietly(() => sleepWatchingHeads(r.engine, state, { sleepMs: 30_000, baseInterval: 300, jsonMode: true }, deps));
          expect({ off, reads, jobs: await syncJobs(r.engine, r.sourceId) }).toEqual({ off: [], reads: 0, jobs: [] });

          await r.engine.setConfig('sync.on_commit', 'true');
          clock = 1_500_000;
          const deferred = await quietly(() => sleepWatchingHeads(r.engine, state, { sleepMs: 30_000, baseInterval: 300, jsonMode: true }, { ...deps, notifierActive: () => true }));
          expect({ deferred, reads, jobs: await syncJobs(r.engine, r.sourceId) }).toEqual({ deferred: [], reads: 0, jobs: [] });

          clock = 2_000_000;
          const on = await quietly(() => sleepWatchingHeads(r.engine, state, { sleepMs: 30_000, baseInterval: 300, jsonMode: true }, deps));
          expect(on.length).toBe(1);
          expect(on[0]!.at).toBe(2_003_000);
          expect(on[0]!.moved).toEqual([r.sourceId]);
          expect(on[0]!.decisions.filter(d => d.source_id === r.sourceId)).toMatchObject([{ outcome: 'dispatched', trigger: 'head', head }]);
          expect(state.freshnessHeads.get(r.sourceId)).toBe(head);
          expect((await syncJobs(r.engine, r.sourceId)).map(j => j.idempotency_key)).toEqual(['autopilot-sync:' + r.sourceId + ':head:' + head]);
        });
      }, 240_000);
    });
  }
}
