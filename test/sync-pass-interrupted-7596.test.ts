/**
 * #7596: a managed sync killed mid-batch (an external memory guard's SIGTERM, an OOM SIGKILL) leaves its pass row open.
 * `sync status` read that row as a pass still in progress: `resumable` / `pass_unfinished`, the same as a pass that stopped
 * cleanly at its deadline, and after a SIGKILL it listed the dead process under `live` because its lock row outlives it.
 * Doctor `managed_sync_blocked` listed nothing. An open pass with no process renewing the source's drain lease is now
 * `pass_interrupted` in status (with `interrupted` naming the pass and the dead holder) and in doctor.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../src/commands/doctor.ts';
import { managedSyncBlockedEntry } from '../src/commands/doctor/checks/managed-sync-blocked.ts';
import * as dbLock from '../src/core/db-lock.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { readBlockedManagedSyncs } from '../src/core/persistence/sync-blocked.ts';
import { abandonedPasses, passStatusNext, passStatusState } from '../src/core/persistence/sync-pass-status.ts';
import { MANAGED_SYNC_PASS_OP, type PassRow, readPassRow } from '../src/core/persistence/sync-pass-row.ts';
import { liveSyncJob } from '../src/core/persistence/sync-movement.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const now = Date.parse('2026-10-25T12:00:00Z');
const row = (outcome: string, streak: number | undefined, quietMs: number): PassRow => ({ updated_at: new Date(now - quietMs).toISOString(),
  value: { source_id: 's', incarnation: 'i', lease_token: 't', obligations: { baseline_commit: null, mismatch: {}, not_converged_streak: 0, faults: {}, ...(streak ? { abandoned_streak: streak } : {}) },
    telemetry: { pass_id: 'p', target: 'h', started_at: '', ended_at: null, kind: 'full', round: 0, outcome: outcome as never, stop_reason: null, candidates: 0, settled: 0, remaining: 0, counts: {}, duration_ms: null, timings_ms: {} } } });

describe('#7596: an open pass with no live drain-lease holder reads interrupted', () => {
  test('the first interrupted pass is resumable pass_interrupted and next is the plain sync', () => {
    const open = row('open', undefined, 10_000);
    expect(passStatusState(open, null, null, now, true)).toEqual(['resumable', 'pass_interrupted']);
    const next = passStatusNext('s', 'pass_interrupted', open, ['--source', 's'], null, true);
    expect(next.argv).toEqual(['gbrain', 'sync', '--source', 's']);
    expect(next.why).toContain('killed or crashed');
    // A pass whose process still renews the lease is running, not interrupted.
    expect(passStatusState(open, null, null, now, false)).toEqual(['resumable', 'pass_unfinished']);
    expect(passStatusState(row('synced', undefined, 10_000), null, null, now, true)).toBeNull();
  });

  test('an interrupted pass after an abandoned one is blocked pass_abandoned without waiting out the quiet window', () => {
    const second = row('open', 1, 10_000);
    expect(abandonedPasses(second, now, true)).toBe(2);
    expect(passStatusState(second, null, null, now, true)).toEqual(['blocked', 'pass_abandoned']);
    expect(passStatusState(second, null, null, now, false)).toEqual(['resumable', 'pass_unfinished']);
    // A pass writes its row per batch, so a live holder committing pages for minutes is not quiet, whatever its row's age.
    expect(passStatusState(row('open', 1, 6 * 60_000), null, null, now, false)).toEqual(['resumable', 'pass_unfinished']);
  });
});

const lockRow = (engine: BrainEngine, beat: string, ttl: string) => engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,last_refreshed_at)
  VALUES($1,$2,$3,now()-interval '10 minutes',now()+$5::interval,now()-$4::interval)
  ON CONFLICT(id) DO UPDATE SET holder_pid=EXCLUDED.holder_pid,ttl_expires_at=EXCLUDED.ttl_expires_at,last_refreshed_at=EXCLUDED.last_refreshed_at`, [syncLockId('default'), 4242, hostname(), beat, ttl]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`#7596 [${backend}]: a killed pass is pass_interrupted in sync status and doctor, and a live one is not`, () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toMatch(/^(first_sync|synced)$/);
    const blocked = async () => (await readBlockedManagedSyncs(engine, ['default'])).filter(entry => entry.source_id === 'default');
    const doctor = async () => (await managedSyncBlockedEntry.run({ engine } as never) as Check[])[0]!;
    expect(await blocked()).toEqual([]);

    // The pass's process was killed: its row is left open and its drain lease released (a SIGTERM's cleanup).
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,telemetry,outcome}','"open"') WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
    const [{ pass_id }] = await engine.executeRaw<{ pass_id: string }>(`SELECT completed_keys->0->'telemetry'->>'pass_id' AS pass_id FROM op_checkpoints WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
    let status = await readSyncStatus(engine, 'default', { detail: false });
    expect([status.state, status.reason]).toEqual(['resumable', 'pass_interrupted']);
    expect(status.live).toBeNull();
    expect(status.interrupted).toMatchObject({ pass_id, holder: null });
    expect(status.next?.argv?.slice(0, 4)).toEqual(['gbrain', 'sync', '--source', 'default']);
    expect(status.next?.why).toContain('killed or crashed');
    expect(await blocked()).toEqual([expect.objectContaining({ code: 'pass_interrupted', run_id: pass_id })]);
    expect(await doctor()).toMatchObject({ name: 'managed_sync_blocked', status: 'warn' });

    // A SIGKILL leaves the lock row behind, its renewals stopped three minutes ago: still no live holder.
    await lockRow(engine, '3 minutes', '-1 minute');
    status = await readSyncStatus(engine, 'default', { detail: false });
    expect([status.state, status.reason]).toEqual(['resumable', 'pass_interrupted']);
    expect(status.live).toBeNull();
    expect(status.interrupted?.holder).toMatchObject({ pid: 4242 });
    expect(await blocked()).toEqual([expect.objectContaining({ code: 'pass_interrupted' })]);

    // A lease that cannot be read decides nothing: the fresh open pass reads unfinished, and doctor lists nothing for it.
    const passRowNow = () => engine.executeRaw(`SELECT completed_keys, updated_at FROM op_checkpoints WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
    const before = await passRowNow();
    const lockReads = [spyOn(dbLock, 'inspectLock').mockRejectedValue(new Error('lock read failed')), spyOn(dbLock, 'inspectLocks').mockRejectedValue(new Error('lock read failed'))];
    try {
      status = await readSyncStatus(engine, 'default', { detail: false });
      expect(await passRowNow()).toEqual(before);
      expect(status.reason).toBe('pass_unfinished');
      expect(status.interrupted).toBeNull();
      expect(await blocked()).toEqual([]);
    } finally { for (const spy of lockReads) spy.mockRestore(); }

    // Passes in a row keep stopping that way: status and doctor both read pass_abandoned, with the lock row left or released.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,obligations,abandoned_streak}','1') WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
    for (const release of [false, true]) {
      if (release) await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [syncLockId('default')]);
      status = await readSyncStatus(engine, 'default', { detail: false });
      expect([status.state, status.reason]).toEqual(['blocked', 'pass_abandoned']);
      expect(status.interrupted).toMatchObject({ pass_id });
      expect(await blocked()).toEqual([expect.objectContaining({ code: 'pass_abandoned', run_id: pass_id })]);
    }
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=completed_keys #- '{0,obligations,abandoned_streak}' WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);

    // An interrupted pass stopped for over an hour fails doctor.
    await engine.executeRaw(`UPDATE op_checkpoints SET updated_at=now()-interval '2 hours' WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
    expect(await doctor()).toMatchObject({ name: 'managed_sync_blocked', status: 'fail' });
    await lockRow(engine, '3 minutes', '-1 minute');

    // A killed sync job's lock row still names the job: no reader counts it as a live job (the autopilot's freshness skip reads liveSyncJob).
    await engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid() WHERE id=$1', [syncLockId('default')]);
    await engine.executeRaw(`INSERT INTO minion_jobs(name,queue,status,submission_authority,data,max_attempts,max_stalled,lock_token,lock_until,started_at,remove_on_complete,remove_on_fail)
      SELECT 'sync','gbrain-drain-lease','active','{"version":1,"kind":"application"}'::jsonb,$2::text::jsonb,1,0,acquisition_token::text,now()-interval '1 minute',now(),true,true
      FROM gbrain_cycle_locks WHERE id=$1`, [syncLockId('default'), JSON.stringify({ sourceId: 'default', drain_lease_beacon: { kind: 'job', id: '4242' } })]);
    expect(await liveSyncJob(engine, 'default')).toBeNull();
    status = await readSyncStatus(engine, 'default', { detail: false });
    expect([status.reason, status.live, status.live_job_id]).toEqual(['pass_interrupted', null, null]);
    expect(status.interrupted?.holder).toMatchObject({ kind: 'job', id: '4242' });
    await engine.executeRaw("DELETE FROM minion_jobs WHERE queue='gbrain-drain-lease'");

    // A holder that renewed the lease just now is a pass still running: not interrupted, not blocked.
    await lockRow(engine, '1 second', '2 minutes');
    status = await readSyncStatus(engine, 'default', { detail: false });
    expect(status.reason).toBe('pass_unfinished');
    expect(status.live).toMatchObject({ pid: 4242 });
    expect(status.interrupted).toBeNull();
    expect(await blocked()).toEqual([]);

    // Resuming: a plain sync takes the dead holder's expired lock over and ends the pass, and after a second
    // interrupted pass it also clears the streak. Nothing reads interrupted or abandoned afterwards.
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const resume = async () => {
      const result = await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
      const ended = (await readPassRow(engine, 'default', incarnation!))!;
      expect([result.status, ended.value.telemetry.outcome, abandonedPasses(ended), passStatusState(ended, null)]).toEqual(['up_to_date', 'up_to_date', 0, null]);
      expect(await engine.executeRaw('SELECT 1 FROM gbrain_cycle_locks WHERE id=$1', [syncLockId('default')])).toHaveLength(0);
      expect(await blocked()).toEqual([]);
      expect((await readSyncStatus(engine, 'default', { detail: false })).interrupted).toBeNull();
    };
    await lockRow(engine, '3 minutes', '-1 minute');
    await resume();
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(jsonb_set(completed_keys,'{0,telemetry,outcome}','"open"'),'{0,obligations,abandoned_streak}','1') WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
    expect((await readSyncStatus(engine, 'default', { detail: false })).reason).toBe('pass_abandoned');
    await resume();
  }, { databaseUrl, setup: ({ root }) => {
    git(root, ['init', '-q']);
    writeFileSync(join(root, 'a.md'), '---\ntype: concept\ntitle: a\n---\n\nA note about a.\n');
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'a']);
  } }), 120_000);
}
