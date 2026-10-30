/**
 * #6712 PR 4b lane S (design v3.2 §8, probe 51 switch half): the `sync.admission` switch.
 *
 * Protects:
 *   - `config set sync.admission` refuses any value outside `normal | imports_only | classify_only` (exit 2, nothing
 *     written, `--force` included), and `config get` prints the value in effect (`normal` when unset);
 *   - each value is stored with its `set_at` (database clock) and a transaction's `readSyncAdmission` sees it;
 *   - `effective` is false while a pass pinned before `set_at` holds the live drain lease, or a destructive request
 *     (`managed_sync_delete`, `canonical_reconcile`) admitted before it is unpublished, and true after;
 *   - doctor `sync_admission_restricted` warns on a managed brain while the value is not `normal`, with its age and the
 *     restore command for the user, and is ok on `normal` and on a brain that is not managed;
 *   - `sync status` carries `admission`.
 *
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { runConfig } from '../src/commands/config.ts';
import { readSyncAdmission, readSyncAdmissionSetting, syncAdmissionStatus, SYNC_ADMISSION_KEY, SYNC_ADMISSION_SET_OP } from '../src/core/persistence/sync-admission.ts';
import { writePassRow, type ManagedSyncPassValue } from '../src/core/persistence/sync-pass-row.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { syncAdmissionEntry } from '../src/commands/doctor/checks/sync-admission.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { cliRenderContext, renderAction, type Action } from '../src/core/agent-output.ts';
import { syncLockId } from '../src/core/db-lock.ts';

let engine: BrainEngine;
let incarnation: string;
const SOURCE = 'default';

async function reset(): Promise<void> {
  await engine.unsetConfig(SYNC_ADMISSION_KEY);
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=ANY($1::text[])', [[SYNC_ADMISSION_SET_OP, 'managed-sync-pass']]);
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(SOURCE)]);
  // A shared Postgres keeps earlier files' requests for this source, and their effects reference them.
  await engine.executeRaw('DELETE FROM persistence_effects WHERE request_id IN (SELECT id FROM persistence_requests WHERE source_id=$1)', [SOURCE]);
  await engine.executeRaw('DELETE FROM persistence_requests WHERE source_id=$1', [SOURCE]);
}

async function config(args: string[]) {
  const logs: string[] = [], errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const writeSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { errs.push(String(chunk)); return true; }) as never);
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  try { await runConfig(engine, args); }
  catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; }
  finally { logSpy.mockRestore(); errSpy.mockRestore(); writeSpy.mockRestore(); exitSpy.mockRestore(); }
  return { out: logs.join('\n'), err: errs.join('\n'), exit: exit as number | null };
}

function passValue(token: string, startedAt: string, outcome: ManagedSyncPassValue['telemetry']['outcome'] = 'open'): ManagedSyncPassValue {
  return { source_id: SOURCE, incarnation, lease_token: token,
    obligations: { baseline_commit: null, mismatch: {}, not_converged_streak: 0, faults: {} },
    telemetry: { pass_id: randomUUID(), target: 'f'.repeat(40), started_at: startedAt, ended_at: outcome === 'open' ? null : new Date().toISOString(), kind: 'full', round: 1,
      outcome, stop_reason: null, candidates: 3, settled: 0, remaining: 3, counts: {}, duration_ms: null, timings_ms: {} } };
}
async function pinPass(token: string, startedAt: string, outcome: ManagedSyncPassValue['telemetry']['outcome'] = 'open') {
  await engine.transaction(tx => writePassRow(tx, passValue(token, startedAt, outcome), { pin: true }));
}
async function holdLease(token: string) {
  await engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,last_refreshed_at,acquisition_token)
    VALUES($1,4242,'host-example',now(),now()+interval '2 minutes',now(),$2::uuid)
    ON CONFLICT (id) DO UPDATE SET acquisition_token=EXCLUDED.acquisition_token, ttl_expires_at=EXCLUDED.ttl_expires_at`, [syncLockId(SOURCE), token]);
}
async function admitRequest(kind: string, createdAgo: string): Promise<string> {
  const id = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
      state,intent,created_at,updated_at)
    VALUES('local_cli','fixture',$1::uuid,'submit_job',$2,$3::uuid,$4,$5,'{}'::jsonb,0,0,'queued',jsonb_build_object('kind',$6::text),now()-$7::interval,now())`,
  [id, SOURCE, incarnation, `notes/alice-example-${id.slice(0, 8)}`, randomUUID(), kind, createdAgo]);
  return id;
}
/** The standalone read; `sync status` folds the same probes into its source read (GBRA-135) and must agree with it. */
async function status() {
  const standalone = await syncAdmissionStatus(engine, SOURCE, incarnation);
  expect((await readSyncStatus(engine, SOURCE, { detail: false })).admission).toEqual(standalone);
  return standalone;
}
async function setManaged(enabled: boolean) {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("SELECT set_config('gbrain.writer_quiesced','true',true)");
    await tx.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
  });
}

for (const backend of testBackends()) describe(backend, () => {
  beforeAll(async () => {
    if (backend === 'postgres') { const pg = new PostgresEngine(); await pg.connect({ database_url: requirePostgresTestDatabase() } as never); engine = pg; }
    else { const lite = new PGLiteEngine(); await lite.connect({}); engine = lite; }
    await engine.initSchema();
    incarnation = (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [SOURCE]))[0]!.incarnation;
  }, 120_000);
  // A shared Postgres keeps no restricted value for the next file (it cost sync status a statement, GBRA-135).
  afterAll(async () => { await reset(); await engine.disconnect(); });
  beforeEach(reset);

  test('config set sync.admission refuses a value outside the three and writes nothing, --force included', async () => {
    for (const args of [['set', SYNC_ADMISSION_KEY, 'off'], ['set', SYNC_ADMISSION_KEY, 'Normal'], ['set', SYNC_ADMISSION_KEY, 'hold_destructive', '--force']]) {
      const refused = await config(args);
      expect(refused.exit).toBe(2);
      expect(refused.err).toContain('sync.admission is one of normal, imports_only, classify_only');
      expect(refused.err).toContain('Nothing was written');
      expect(await engine.getConfig(SYNC_ADMISSION_KEY)).toBeNull();
    }
    const got = await config(['get', SYNC_ADMISSION_KEY]);
    expect(got.exit).toBeNull();
    expect(got.out).toBe('normal');
    expect(got.err).toContain('default (unset)');
  });

  test('each value is stored with its set_at; a transaction reads it; config get prints the value in effect', async () => {
    for (const value of ['imports_only', 'classify_only', 'normal'] as const) {
      const [{ before }] = await engine.executeRaw<{ before: string }>('SELECT clock_timestamp()::text AS before');
      const set = await config(['set', SYNC_ADMISSION_KEY, value]);
      expect(set.exit).toBeNull();
      expect(set.out).toContain(`Set sync.admission = ${value}`);
      expect(await engine.transaction(tx => readSyncAdmission(tx))).toBe(value);
      const setting = await readSyncAdmissionSetting(engine);
      expect(setting).toMatchObject({ value, stored: value });
      expect(Date.parse(setting.set_at!)).toBeGreaterThanOrEqual(Date.parse(before) - 1);
      const got = await config(['get', SYNC_ADMISSION_KEY]);
      expect(got.out).toBe(value);
      expect(got.err).toContain(`set at ${setting.set_at}`);
    }
    await engine.setConfig(SYNC_ADMISSION_KEY, 'junk');
    expect(await readSyncAdmissionSetting(engine)).toMatchObject({ value: 'classify_only', stored: 'junk', set_at: null });
    const got = await config(['get', SYNC_ADMISSION_KEY]);
    expect(got.out).toBe('classify_only');
    expect(got.err).toContain('fail closed');
  });

  test('effective waits for a pass pinned before set_at that holds the lease, and turns true when it ends or loses the lease', async () => {
    const token = randomUUID();
    await pinPass(token, new Date(Date.now() - 60_000).toISOString());
    await holdLease(token);
    expect((await config(['set', SYNC_ADMISSION_KEY, 'imports_only'])).exit).toBeNull();
    expect(await status()).toMatchObject({ value: 'imports_only', effective: false });
    await pinPass(token, new Date(Date.now() - 60_000).toISOString(), 'synced');
    expect((await status()).effective).toBe(true);
    await pinPass(token, new Date(Date.now() - 60_000).toISOString());
    expect((await status()).effective).toBe(false);
    await engine.executeRaw("UPDATE gbrain_cycle_locks SET ttl_expires_at=now()-interval '1 second' WHERE id=$1", [syncLockId(SOURCE)]);
    expect((await status()).effective).toBe(true);
    await holdLease(randomUUID());
    expect((await status()).effective).toBe(true);
    const next = randomUUID();
    await holdLease(next);
    await pinPass(next, new Date(Date.parse((await readSyncAdmissionSetting(engine)).set_at!) + 1000).toISOString());
    expect((await status()).effective).toBe(true);
    await pinPass(next, new Date(Date.now() - 60_000).toISOString());
    expect((await config(['set', SYNC_ADMISSION_KEY, 'classify_only'])).exit).toBeNull();
    expect((await status()).effective).toBe(false);
    expect((await config(['set', SYNC_ADMISSION_KEY, 'normal'])).exit).toBeNull();
    expect(await status()).toMatchObject({ value: 'normal', effective: true });
  });

  test('effective waits for a destructive request admitted before set_at until it is published', async () => {
    const del = await admitRequest('managed_sync_delete', '1 minute');
    const reconcile = await admitRequest('canonical_reconcile', '1 minute');
    await admitRequest('managed_sync_import', '1 minute');
    expect((await config(['set', SYNC_ADMISSION_KEY, 'imports_only'])).exit).toBeNull();
    expect((await status()).effective).toBe(false);
    await engine.executeRaw("UPDATE persistence_requests SET state='running' WHERE request_id=$1::uuid", [del]);
    await engine.executeRaw("UPDATE persistence_requests SET state='committed', completed_at=now() WHERE request_id=$1::uuid", [reconcile]);
    expect((await status()).effective).toBe(false);
    await engine.executeRaw("UPDATE persistence_requests SET state='cancelled', completed_at=now() WHERE request_id=$1::uuid", [del]);
    expect((await status()).effective).toBe(true);
    await admitRequest('managed_sync_delete', '0 seconds');
    expect((await status()).effective).toBe(true);
    await admitRequest('managed_sync_delete', '1 minute');
    expect((await status()).effective).toBe(false);
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [SYNC_ADMISSION_SET_OP]);
    expect(await status()).toMatchObject({ value: 'imports_only', set_at: null, effective: false });
  });

  test('doctor sync_admission_restricted warns on a managed brain while not normal, and is ok on normal and on a brain that is not managed', async () => {
    const ctx = { engine, progress: { heartbeat: () => {} } } as never;
    expect(await syncAdmissionEntry.run(ctx)).toMatchObject([{ name: 'sync_admission_restricted', status: 'ok' }]);
    expect((await config(['set', SYNC_ADMISSION_KEY, 'imports_only'])).exit).toBeNull();
    expect(await syncAdmissionEntry.run(ctx)).toMatchObject([{ name: 'sync_admission_restricted', status: 'ok', severity: 'info', readiness_state: 'not_applicable' }]);
    await setManaged(true);
    try {
      for (const value of ['imports_only', 'classify_only'] as const) {
        expect((await config(['set', SYNC_ADMISSION_KEY, value])).exit).toBeNull();
        const checks = await syncAdmissionEntry.run(ctx);
        if (!Array.isArray(checks)) throw new Error('sync_admission_restricted returned no checks');
        const [check] = checks;
        expect(check).toMatchObject({ name: 'sync_admission_restricted', status: 'warn', details: { value, age_seconds: expect.any(Number) },
          fix: { argv: ['gbrain', 'config', 'set', 'sync.admission', 'normal'], actor: 'user' } });
        expect(check!.message).toContain(`sync.admission is ${value}, set `);
        expect(check!.message).toContain(' ago (');
        expect(check!.message).toContain('gbrain config set sync.admission normal');
        expect(renderAction(check!.fix as Action, cliRenderContext()).next).toBe('tell_user_to_run');
      }
      expect((await config(['set', SYNC_ADMISSION_KEY, 'normal'])).exit).toBeNull();
      expect(await syncAdmissionEntry.run(ctx)).toMatchObject([{ name: 'sync_admission_restricted', status: 'ok' }]);
    } finally {
      await setManaged(false);
    }
  });

  test('sync status carries admission', async () => {
    expect((await readSyncStatus(engine, SOURCE, { detail: false })).admission).toEqual({ value: 'normal', set_at: null, effective: true });
    expect((await config(['set', SYNC_ADMISSION_KEY, 'classify_only'])).exit).toBeNull();
    const { admission } = await readSyncStatus(engine, SOURCE, { detail: false });
    expect(admission).toMatchObject({ value: 'classify_only', effective: true });
    expect(admission.set_at).toBe((await readSyncAdmissionSetting(engine)).set_at);
  });
});
