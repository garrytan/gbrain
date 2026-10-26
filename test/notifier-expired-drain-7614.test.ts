import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { assertDrainLease, currentDrainLease, readDrainHolder, withDrainLease } from '../src/core/persistence/sync-lease.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { runnerStart } from '../src/core/notifier/resident.ts';
import { formatNotifierBlock, readNotifierBlock } from '../src/core/notifier/status.ts';
import { readAppliedWatermark } from '../src/core/persistence/applied-watermark.ts';
import { startCommitNotifier } from '../src/core/commit-notifier.ts';
import { memoryNotifierStore } from './helpers/notifier-memory-store.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { pathologicalArms } from './pathological/harness.ts';

const SOURCE = 'expired-drain-example';
const SIBLING = 'live-drain-example';
const HOST = 'other-host-example';

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`expired notifier drain lease (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
      for (const id of [SOURCE, SIBLING]) {
        await engine.executeRaw('INSERT INTO sources(id,name,config) VALUES($1,$1,$2::text::jsonb)', [id, '{}']);
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = ANY($1::text[])', [[syncLockId(SOURCE), syncLockId(SIBLING)]]);
    });

    async function lock(sourceId: string, ttl: string, beat: string | null, age = '-10 minutes') {
      await engine.executeRaw(`INSERT INTO gbrain_cycle_locks
        (id,holder_pid,holder_host,acquired_at,ttl_expires_at,last_refreshed_at,acquisition_token)
        VALUES($1,4242,$2,now()+$5::interval,now()+$3::interval,
          CASE WHEN $4::text IS NULL THEN NULL ELSE now()+$4::interval END,'00000000-0000-4000-8000-000000000014')`,
      [syncLockId(sourceId), HOST, ttl, beat, age]);
    }

    test('the notifier starts due work after lease expiry instead of retrying a dead holder forever; a live sibling stays deferred', async () => {
      await lock(SOURCE, '-10 minutes', '-10 minutes');
      await lock(SIBLING, '2 minutes', '0 seconds', '-1 minutes');
      const held = runnerStart(engine).drainHeld!;
      const starts: string[] = [];
      const store = memoryNotifierStore({ lastCommit: () => 'a'.repeat(40) });
      const watcher = startCommitNotifier({ resident: 'serve', log() {}, hostId: HOST, store, maxConcurrent: 2,
        readFlag: async () => true, listSources: async () => [SOURCE, SIBLING].map(sourceId => ({
          sourceId, root: '/example', gitDir: null, lastCommit: 'a'.repeat(40), kind: 'classic' as const,
        })),
        lastCommit: async () => 'a'.repeat(40), revParse: async () => 'b'.repeat(40),
        syncRunning: () => false, drainHeld: held,
        startSync: async sourceId => { starts.push(sourceId); return { jobId: `job-${sourceId}` }; },
        jobStatus: () => ({ state: 'running' }), quiet: () => true,
        setInterval: () => 'interval', clearInterval() {}, setTimeout: () => 'timer', clearTimeout() {},
      });
      try {
        await watcher.tick();
        expect(starts).toEqual([SOURCE]);
        expect(watcher.decisions.some(d => d.decision === 'defer_drain_lease' && d.source === SIBLING)).toBe(true);
        expect(store.states.get(SOURCE)?.state).toBe('running');
        // Observation never breaks the row; acquisition/fencing still owns takeover.
        expect(await readDrainHolder(engine, SOURCE)).not.toBeNull();
      } finally { await watcher.stop(); }
    });

    test('status offers sync-now immediately after expiry, not a fictional active writer or a delayed stalled warning', async () => {
      await lock(SOURCE, '-1 minutes', '-3 minutes', '-3 minutes');
      const block = await readNotifierBlock(engine, SOURCE);
      expect(block?.drain_holder).toBeNull();
      expect(block?.fix?.argv).toEqual(['gbrain', 'sync', '--source', SOURCE, '--no-pull']);
      expect(formatNotifierBlock(SOURCE, block!)).not.toContain('holds the drain lease');
      const remote = await readNotifierBlock(engine, SOURCE, { remote: true });
      expect(remote?.drain_holder).toBeNull();
      expect(remote?.fix).not.toBeNull();
      expect(JSON.stringify(remote)).not.toContain(HOST);
    });

    test('the applied watermark does not advertise an expired heartbeat as a writer that will make progress', async () => {
      await lock(SOURCE, '-10 minutes', '-10 minutes');
      const watermark = await readAppliedWatermark(engine, SOURCE, { remote: true });
      expect(watermark.writer_heartbeat).toEqual({ holder: null, heartbeat_age_seconds: null,
        last_progress_at: null, progress_age_seconds: null, stalled: false });
      expect(await readDrainHolder(engine, SOURCE)).not.toBeNull();
    });

    test.each([
      ['unexpired TTL despite old heartbeat', '2 minutes', '-10 minutes'],
      ['expired TTL inside renewal grace', '-1 seconds', '0 seconds'],
      ['legacy unexpired TTL without heartbeat', '2 minutes', null],
    ])('preserves %s', async (_name, ttl, beat) => {
      await lock(SOURCE, ttl!, beat);
      expect(await runnerStart(engine).drainHeld!(SOURCE)).toBe('stalled');
      const block = await readNotifierBlock(engine, SOURCE);
      expect(block?.drain_holder).not.toBeNull();
      const remote = await readNotifierBlock(engine, SOURCE, { remote: true });
      expect(remote?.drain_holder).toMatchObject({ host: null, pid: null, id: null });
      expect((await readAppliedWatermark(engine, SOURCE, { remote: true })).writer_heartbeat.holder)
        .toMatchObject({ kind: 'unknown', host: null, pid: null, id: null });
    });

    test('an expired legacy lock with no heartbeat no longer suppresses recovery', async () => {
      await lock(SOURCE, '-10 minutes', null);
      expect(await runnerStart(engine).drainHeld!(SOURCE)).toBe(false);
      expect((await readNotifierBlock(engine, SOURCE))?.drain_holder).toBeNull();
    });

    test('recovery still acquires a new fencing token and releases it normally', async () => {
      await lock(SOURCE, '-10 minutes', '-10 minutes');
      expect(await runnerStart(engine).drainHeld!(SOURCE)).toBe(false);
      let token: string | undefined;
      await withDrainLease(engine, SOURCE, { holder: { kind: 'serve', id: 'recovery-example' } }, async () => {
        token = currentDrainLease(SOURCE)?.token;
        await engine.transaction(tx => assertDrainLease(tx, SOURCE));
        const holder = await readDrainHolder(engine, SOURCE, { liveOnly: true });
        expect(holder).toMatchObject({ kind: 'serve', id: 'recovery-example' });
        expect(await runnerStart(engine).drainHeld!(SOURCE)).toBe(true);
        return { status: 'synced' } as SyncResult;
      });
      expect(token).toBeDefined();
      expect(token).not.toBe('00000000-0000-4000-8000-000000000014');
      expect(await readDrainHolder(engine, SOURCE)).toBeNull();
    });

    test('an unavailable lock read refuses scheduling instead of assuming the lease is free', async () => {
      const fail = async () => { throw new Error('lock read unavailable'); };
      const unavailable = { kind: engine.kind, sql: fail, db: { query: fail } } as unknown as BrainEngine;
      await expect(runnerStart(unavailable).drainHeld!(SOURCE)).rejects.toThrow('lock read unavailable');
    });
  });
}
