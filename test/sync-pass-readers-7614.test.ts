/**
 * #7611 / #7614 (the sync wave after #7603): the readers of a managed sync pass and its drain lease decide from one
 * consistent observation on the database clock. A live holder renewing the lease over a stored abandoned streak is running
 * (#7611); a reader whose clock runs ahead of the database still sees a renewing holder; a pass that ended and released its
 * lease between two reads is not reported killed; a lock read that failed keeps status's quiet-window rule in doctor too; an
 * archived source is not listed; a stop the run records nowhere (a lost connection, a lost lease) ends the row resumable, so
 * only a dead process leaves it open; and the notifier and watermark readers no longer stand a killed holder in for a live one.
 */
import { OperationError } from '../src/core/ops/contract.ts';
import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../src/commands/doctor.ts';
import { managedSyncBlockedEntry } from '../src/commands/doctor/checks/managed-sync-blocked.ts';
import { readBrainHealthBands } from '../src/commands/doctor/brain-health-bands.ts';
import { runSyncStatus } from '../src/commands/sync/operator.ts';
import * as dbLock from '../src/core/db-lock.ts';
import { LockStolenError, syncLockId } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runnerStart } from '../src/core/notifier/resident.ts';
import { readNotifierBlock } from '../src/core/notifier/status.ts';
import { readAppliedWatermark } from '../src/core/persistence/applied-watermark.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { readBlockedManagedSyncs } from '../src/core/persistence/sync-blocked.ts';
import { readSourceMovement } from '../src/core/persistence/sync-movement.ts';
import * as passStatus from '../src/core/persistence/sync-pass-status.ts';
import { abandonedPasses, passStatusState } from '../src/core/persistence/sync-pass-status.ts';
import { MANAGED_SYNC_PASS_OP, type PassRow, readPassRow } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const now = Date.parse('2026-10-26T12:00:00Z');
const row = (streak: number | undefined, quietMs: number): PassRow => ({ updated_at: new Date(now - quietMs).toISOString(),
  value: { source_id: 's', incarnation: 'i', lease_token: 't', obligations: { baseline_commit: null, mismatch: {}, not_converged_streak: 0, faults: {}, ...(streak ? { abandoned_streak: streak } : {}) },
    telemetry: { pass_id: 'p', target: 'h', started_at: '', ended_at: null, kind: 'full', round: 0, outcome: 'open', stop_reason: null, candidates: 0, settled: 0, remaining: 0, counts: {}, duration_ms: null, timings_ms: {} } } });

describe('#7611: a stored abandoned streak under a live holder', () => {
  test('a live holder renewing the lease makes the open pass running, whatever streak earlier passes stored', () => {
    const open = row(2, 10_000);
    expect(abandonedPasses(open, now, false)).toBe(0);
    expect(passStatusState(open, null, null, now, false)).toEqual(['resumable', 'pass_unfinished']);
    // The streak counts again once the holder stops renewing (or when no lease reading decides it, by the quiet window).
    expect(passStatusState(open, null, null, now, true)).toEqual(['blocked', 'pass_abandoned']);
    expect(passStatusState(row(2, 6 * 60_000), null, null, now)).toEqual(['blocked', 'pass_abandoned']);
  });
});

const LOCK = syncLockId('default');
const lockRow = (engine: BrainEngine, beat: string, ttl: string) => engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,last_refreshed_at)
  VALUES($1,$2,$3,now()-interval '10 minutes',now()+$5::interval,now()-$4::interval)
  ON CONFLICT(id) DO UPDATE SET holder_pid=EXCLUDED.holder_pid,acquired_at=EXCLUDED.acquired_at,ttl_expires_at=EXCLUDED.ttl_expires_at,last_refreshed_at=EXCLUDED.last_refreshed_at`, [LOCK, 4242, hostname(), beat, ttl]);
const live = (engine: BrainEngine) => lockRow(engine, '1 second', '2 minutes');
const dead = (engine: BrainEngine) => lockRow(engine, '3 minutes', '-1 minute');
const unlock = (engine: BrainEngine) => engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [LOCK]);
const setPass = (engine: BrainEngine, outcome: string, streak: number, age = '0 seconds') => engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(jsonb_set(completed_keys,
  '{0,telemetry,outcome}',to_jsonb($2::text)),'{0,obligations,abandoned_streak}',to_jsonb($3::int)), updated_at=now()-$4::interval WHERE op=$1`, [MANAGED_SYNC_PASS_OP, outcome, streak, age]);
const commitFile = (root: string, name: string) => { writeFileSync(join(root, name), `---\ntype: concept\ntitle: ${name}\n---\n\nA note about ${name}.\n`); git(root, ['add', '-A']); git(root, ['commit', '-qm', name]); };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  /** A managed brain whose first sync converged, its pass row then edited by each case. */
  const synced = (name: string, run: (brain: { engine: BrainEngine; root: string; sync: () => ReturnType<typeof performManagedSync>; status: () => ReturnType<typeof readSyncStatus>;
    blocked: (ids?: string[]) => Promise<Array<{ source_id: string; code: string }>> }) => Promise<void>) => test(`${name} [${backend}]`, () => managedBrain(async ({ engine, root }) => {
    const sync = () => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
    expect((await sync()).status).toMatch(/^(first_sync|synced)$/);
    await run({ engine, root, sync, status: () => readSyncStatus(engine, 'default', { detail: false }),
      blocked: async (ids = ['default']) => (await readBlockedManagedSyncs(engine, ids)).filter(entry => ids.includes(entry.source_id)) });
  }, { databaseUrl, setup: ({ root }) => { git(root, ['init', '-q']); commitFile(root, 'a.md'); } }), 120_000);

  synced('#7611: a pass drained under a live lease over a stored abandoned streak is running in status and doctor', async ({ engine, status, blocked }) => {
    await setPass(engine, 'open', 2);
    await live(engine);
    expect([(await status()).state, (await status()).reason]).toEqual(['resumable', 'pass_unfinished']);
    expect((await status()).live).toMatchObject({ pid: 4242 });
    expect(await blocked()).toEqual([]);
    // Once that holder stops renewing, the stored streak counts again.
    await dead(engine);
    expect((await status()).reason).toBe('pass_abandoned');
    expect(await blocked()).toEqual([expect.objectContaining({ code: 'pass_abandoned' })]);
  });

  synced('#7614: drain-lease liveness reads the database clock, not the reader\'s', async ({ engine, status, blocked }) => {
    // A reader whose clock runs half an hour ahead still sees a renewing holder. (PGLite's clock is the process's own, so
    // only a database server can run behind the reader.)
    await setPass(engine, 'open', 0);
    await live(engine);
    const realNow = Date.now.bind(Date);
    const ahead = spyOn(Date, 'now').mockImplementation(() => realNow() + (backend === 'postgres' ? 30 * 60_000 : 0));
    try {
      const snap = await dbLock.inspectLock(engine, LOCK);
      expect(snap && dbLock.isLockHolderLive(snap, 2)).toBe(true);
      expect((await status()).interrupted).toBeNull();
      expect(await blocked()).toEqual([]);
    } finally { ahead.mockRestore(); }
  });

  synced('#7614: a pass that ends and releases its lease between the pass read and the lease read is not reported killed', async ({ engine, status, blocked }) => {
    const endBetween = (name: 'inspectLock' | 'inspectLocks') => {
      const original = dbLock[name] as (...args: unknown[]) => Promise<unknown>;
      return spyOn(dbLock, name).mockImplementation((async (...args: unknown[]) => {
        await setPass(engine, 'up_to_date', 0); await unlock(engine);
        return original(...args);
      }) as never);
    };
    await setPass(engine, 'open', 1); await dead(engine);
    let race = endBetween('inspectLock');
    try {
      const raced = await status();
      expect(raced.interrupted).toBeNull();
      expect(raced.reason).not.toMatch(/^pass_(interrupted|abandoned)$/);
    } finally { race.mockRestore(); }
    await setPass(engine, 'open', 1); await dead(engine);
    race = endBetween(typeof (dbLock as Record<string, unknown>).inspectLocks === 'function' ? 'inspectLocks' : 'inspectLock');
    try { expect(await blocked()).toEqual([]); } finally { race.mockRestore(); }
  });

  synced('#7614: a lock read that failed keeps the quiet-window rule in doctor as in status', async ({ engine, status, blocked }) => {
    await setPass(engine, 'open', 1, '10 minutes'); await dead(engine);
    const failed = (['inspectLock', 'inspectLocks'] as const).filter(name => typeof (dbLock as Record<string, unknown>)[name] === 'function')
      .map(name => spyOn(dbLock, name).mockRejectedValue(new Error('lock read failed')));
    try {
      expect((await status()).reason).toBe('pass_abandoned');
      expect(await blocked()).toEqual([expect.objectContaining({ code: 'pass_abandoned' })]);
      // A fresh open row with no streak decides nothing without the lease: neither lists it.
      await setPass(engine, 'open', 0);
      expect((await status()).reason).toBe('pass_unfinished');
      expect(await blocked()).toEqual([]);
    } finally { for (const spy of failed) spy.mockRestore(); }
  });

  synced('#7652 review: a failed re-read of the open pass row decides nothing in status and lists nothing in doctor', async ({ engine, status, blocked }) => {
    await setPass(engine, 'open', 0); await dead(engine);
    const failed = spyOn(passStatus, 'openPassRowsStill').mockRejectedValue(new Error('pass row read failed'));
    try {
      expect((await status()).reason).toBe('pass_unfinished');
      expect(await blocked()).toEqual([]);
    } finally { failed.mockRestore(); }
  });

  synced('#7614: doctor\'s message for killed passes only, the human INTERRUPTED line and the sync_blocked health band', async ({ engine }) => {
    // Killed passes only: doctor does not say freshness jobs end dead (a resume over a killed pass completes).
    await setPass(engine, 'open', 1); await unlock(engine);
    const warned = (await managedSyncBlockedEntry.run({ engine } as never) as Check[])[0]!;
    expect(warned).toMatchObject({ name: 'managed_sync_blocked', status: 'warn' });
    expect(warned.message).not.toContain('Freshness sync jobs');
    const printed = async () => {
      const out: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.join(' ')); });
      try { await runSyncStatus(engine, ['--source', 'default']); } finally { log.mockRestore(); }
      return out.join('\n');
    };
    await setPass(engine, 'open', 0);
    expect(await printed()).toMatch(/INTERRUPTED: pass \w+ stopped before it ended \(last write [^)]+\)$/m);
    await dead(engine);
    expect(await printed()).toContain('(PID 4242) stopped renewing the lease at');
    // An interrupted pass over an hour old turns get_brain_health to attention with a sync_blocked band.
    await unlock(engine); await setPass(engine, 'open', 0, '2 hours');
    expect(await readBrainHealthBands(engine, { sourceIds: ['default'] }, Date.now() + 7_000_000)).toMatchObject({ status: 'attention', sync_blocked: { band: '1-9' } });
  });

  synced('#7614: the notifier block, the on-commit notifier and the writer heartbeat do not count a killed holder', async ({ engine }) => {
    await setPass(engine, 'open', 0); await dead(engine);
    const drainHeld = runnerStart(engine).drainHeld!;
    expect(await drainHeld('default')).toBe(false);
    expect((await readAppliedWatermark(engine, 'default', { behind: async () => null })).writer_heartbeat.holder).toBeNull();
    await engine.executeRaw('INSERT INTO sync_notifier_sources(source_id) VALUES($1) ON CONFLICT DO NOTHING', ['default']);
    const notifier = await readNotifierBlock(engine, 'default');
    expect(notifier?.drain_holder).toBeNull();
    expect(notifier?.fix?.argv).toEqual(['gbrain', 'sync', '--source', 'default', '--no-pull']);
    await live(engine);
    expect(await drainHeld('default')).toBe(true);
    expect((await readNotifierBlock(engine, 'default'))?.drain_holder).toMatchObject({ pid: 4242 });
    expect((await readAppliedWatermark(engine, 'default', { behind: async () => null })).writer_heartbeat.holder).toMatchObject({ pid: 4242 });
  });

  synced('#7614: a renewing holder that makes no progress reads not moving; open passes of several sources in one read', async ({ engine, blocked }) => {
    await setPass(engine, 'open', 0); await live(engine);
    expect((await readSourceMovement(engine, { sourceIds: ['default'], now: Date.now() + 3 * 3_600_000 }))[0]).toMatchObject({ movement_state: 'not_moving', live: { drain: true } });
    // Two open-pass sources: only the one with no live holder is listed; an archived source's killed pass is not.
    const topology = (sql: string) => engine.transaction(async tx => { await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)"); await tx.executeRaw(sql); });
    await topology("INSERT INTO sources(id,name) VALUES('source-b','source-b')");
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) SELECT op,'source-b:'||(SELECT incarnation::text FROM sources WHERE id='source-b'),
      jsonb_set(completed_keys,'{0,source_id}','"source-b"'),updated_at FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE 'default:%'`, [MANAGED_SYNC_PASS_OP]);
    const both = async () => (await blocked(['default', 'source-b'])).map(entry => [entry.source_id, entry.code]);
    expect(await both()).toEqual([['source-b', 'pass_interrupted']]);
    await topology("UPDATE sources SET archived=true WHERE id='source-b'");
    expect(await both()).toEqual([]);
    await unlock(engine);
    expect(await both()).toEqual([['default', 'pass_interrupted']]);
  });

  synced('#7614: a lost connection or a lost lease ends the pass row resumable, so no streak builds and nothing reads killed', async ({ engine, root, sync, status, blocked }) => {
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const lostConnection = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
    for (const [i, [thrown, reason]] of ([[lostConnection, 'transient'], [() => new LockStolenError(LOCK, 'the drain lease of source default lapsed in this pass'), 'lease_lost'],
      [lostConnection, 'transient']] as const).entries()) {
      commitFile(root, `stop-${i}.md`);
      installFaultHook(async point => { if (point === 'sync:round_start') throw thrown(); });
      try {
        // A lost connection reaches the caller; a lost lease reads as the lease held by another drainer (partial, nothing lost).
        if (reason === 'transient') await expect(sync()).rejects.toThrow('Connection terminated unexpectedly');
        else expect(await sync()).toMatchObject({ status: 'partial', reason: 'drain_lease_held' });
      } finally { installFaultHook(undefined); }
      const stopped = (await readPassRow(engine, 'default', incarnation!))!;
      expect([stopped.value.telemetry.outcome, stopped.value.telemetry.stop_reason, abandonedPasses(stopped)]).toEqual(['resumable', reason, 0]);
      expect((await status()).reason).toBe('pass_unfinished');
      expect(await blocked()).toEqual([]);
    }
    expect((await sync()).status).toMatch(/^(up_to_date|synced)$/);
  });

  synced('#7614 review: a permission refusal is not a passing stop; the pass row stays open and reads interrupted, then abandoned', async ({ engine, root, sync, status, blocked }) => {
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    for (const i of [0, 1]) {
      commitFile(root, `denied-${i}.md`);
      installFaultHook(async point => { if (point === 'sync:round_start') throw new OperationError('permission_denied', 'The writer grant for source default was revoked.'); });
      try { await expect(sync()).rejects.toThrow('revoked'); } finally { installFaultHook(undefined); }
      const stopped = (await readPassRow(engine, 'default', incarnation!))!;
      expect(stopped.value.telemetry.outcome).not.toBe('resumable');
      expect(stopped.value.telemetry.stop_reason ?? null).not.toBe('transient');
    }
    expect((await status()).reason).toBe('pass_abandoned');
    expect((await blocked()).map(entry => entry.code)).toEqual(['pass_abandoned']);
  });
}
