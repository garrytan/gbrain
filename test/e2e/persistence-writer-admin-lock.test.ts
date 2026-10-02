import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { acceptWriterTransfer, claimWorktree, prepareWriterTransfer } from '../../src/core/persistence/ownership.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { writeWriterAdminLock } from '../../src/core/persistence/admin-lock.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from '../helpers/writer-admin-intent.ts';
import { withEnv } from '../helpers/with-env.ts';

const run = process.env.DATABASE_URL ? test : test.skip;
const LOCK_KEY = 'persistence.writer_admin_lock';
const DOCS = 'docs/guides/write-refusals.md#writer_admin_locked';
let engine: PostgresEngine;
let close: (() => Promise<void>) | undefined;
let home: string;
let root: string;
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  home = mkdtempSync(join(tmpdir(), 'gbrain-admin-lock-pg-'));
  root = join(home, 'canonical'); mkdirSync(root);
  writeFileSync(join(root, 'example.md'), 'generic example');
  const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
  engine = isolated.engine; close = isolated.close;
  const [database] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${database.name}`;
  mkdirSync(join(home, '.gbrain'));
  mkdirSync(join(home, 'skills'));
  writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Generic fixture skills\n');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: url.toString(), embedding_disabled: true }));
  await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
}, 60_000);
afterAll(async () => {
  if (engine) await disposePersistenceConsumer(engine);
  await close?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../src/cli.ts'), ...args], {
    cwd: home, env: { ...process.env, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0',
      GBRAIN_SKILLS_DIR: join(home, 'skills') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
const settled = <T>(promise: Promise<T>) => {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(value => { state.done = true; state.value = value; }, error => { state.done = true; state.error = error; });
  return state;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

run('PostgreSQL: lock serializes with an in-flight claim, and a claim waits for an in-flight lock', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    localHostId();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let holding = false;
    const lockTx = engine.transaction(async tx => { const result = await writeWriterAdminLock(tx, true); holding = true; await gate; return result; });
    while (!holding) await sleep(10);
    const claim = settled(claimWorktree(engine, 'default', root));
    await sleep(750);
    expect(claim.done).toBe(false);
    release();
    expect(await lockTx).toMatchObject({ changed: true, admin_lock: { locked: true } });
    while (!claim.done) await sleep(10);
    expect(claim.error).toMatchObject({ code: 'writer_admin_locked', docs: DOCS });
    expect(await engine.executeRaw('SELECT id FROM persistence_worktrees')).toEqual([]);

    await runPersistenceAdministration(engine, 'writer_unlock', {});
    // An admin transaction holding the check's share lock keeps a lock attempt waiting until it commits.
    let releaseCheck!: () => void;
    const checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
    let checking = false;
    const checkTx = engine.transaction(async tx => {
      await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE');
      checking = true; await checkGate;
    });
    while (!checking) await sleep(10);
    const locking = settled(runPersistenceAdministration(engine, 'writer_lock', {}));
    await sleep(750);
    expect(locking.done).toBe(false);
    releaseCheck(); await checkTx;
    while (!locking.done) await sleep(10);
    expect(locking.value).toMatchObject({ changed: true, admin_lock: { locked: true } });
    await runPersistenceAdministration(engine, 'writer_unlock', {});

    // Racing claim and lock end in one of the two serial orders.
    const [claimed, locked] = await Promise.allSettled([claimWorktree(engine, 'default', root), runPersistenceAdministration(engine, 'writer_lock', {})]);
    expect(locked.status).toBe('fulfilled');
    const bindings = await engine.executeRaw('SELECT source_id FROM persistence_source_bindings');
    if (claimed.status === 'fulfilled') expect(bindings).toEqual([{ source_id: 'default' }]);
    else { expect(claimed.reason).toMatchObject({ code: 'writer_admin_locked' }); expect(bindings).toEqual([]); }
    await runPersistenceAdministration(engine, 'writer_unlock', {});
    if (claimed.status !== 'fulfilled') await claimWorktree(engine, 'default', root);
  });
}, 120_000);

run('PostgreSQL: internal and CLI callers are refused while locked; config cannot clear the lock; unlock restores administration', async () => {
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const locked = JSON.parse((await cli(['sources', 'writer', 'lock', '--json'])).stdout);
    expect(locked).toMatchObject({ selected_brain: 'host', changed: true, admin_lock: { locked: true, host_id: localHostId() } });
    const status = JSON.parse((await cli(['sources', 'writer', 'status', '--json'])).stdout);
    expect(status).toMatchObject({ selected_brain: 'host', local_host_id: localHostId(), admin_lock: { locked: true, host_id: localHostId(), set_at: locked.admin_lock.set_at } });

    const refused = await cli(['sources', 'writer', 'transfer', 'prepare', 'default', '--admin-intent', 'writer_transfer_prepare', '--expected-state', status.admin_state, '--json']);
    expect(refused.code).toBe(1);
    const body = JSON.parse(refused.stdout);
    expect(body).toMatchObject({ error: 'writer_admin_locked', docs: DOCS });
    expect(body.suggestion).toContain('ask the operator');
    expect(body.suggestion).toContain(DOCS);
    expect(body.suggestion).not.toMatch(/unlock/i);
    expect(refused.stderr).toContain(`Fix: ${body.suggestion}`);

    for (const args of [['config', 'set', LOCK_KEY, '{"locked":false}', '--force'], ['config', 'unset', LOCK_KEY], ['config', 'unset', '--pattern', 'persistence.']]) {
      const result = await cli(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${LOCK_KEY} is reserved`);
    }
    expect(JSON.parse((await engine.getConfig(LOCK_KEY))!)).toMatchObject({ locked: true });

    await expect(prepareWriterTransfer(engine, 'default')).rejects.toMatchObject({ code: 'writer_admin_locked' });
    await expect(activatePersistence(engine, { confirmQuiesced: true })).rejects.toMatchObject({ code: 'writer_admin_locked' });
    expect(await engine.executeRaw('SELECT state FROM persistence_worktrees')).toEqual([{ state: 'active' }]);

    await runPersistenceAdministration(engine, 'writer_unlock', {});
    const prepared = await prepareWriterTransfer(engine, 'default');
    await expect(runPersistenceAdministration(engine, 'writer_lock', {})).rejects.toMatchObject({ code: 'writer_transfer_conflict' });
    await engine.setConfig(LOCK_KEY, JSON.stringify({ locked: true, set_at: new Date().toISOString(), host_id: localHostId(), generation: 50 }));
    await expect(acceptWriterTransfer(engine, 'default', root, prepared.owner_epoch, prepared.manifest.digest)).rejects.toMatchObject({ code: 'writer_admin_locked' });
    await runPersistenceAdministration(engine, 'writer_unlock', {});
    await acceptWriterTransfer(engine, 'default', root, prepared.owner_epoch, prepared.manifest.digest);
    expect(await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') }))
      .toMatchObject({ activated: true });
  });
}, 180_000);
