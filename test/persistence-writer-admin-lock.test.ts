import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acceptWriterTransfer, claimWorktree, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parsePersistenceAdminArgs, WRITER_HELP } from '../src/commands/persistence-admin.ts';
import { runConfig } from '../src/commands/config.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';

const LOCK_KEY = 'persistence.writer_admin_lock';
let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});
beforeEach(async () => { await resetPgliteState(engine); await engine.setConfig('version', schemaVersion); });
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

async function fixture(run: (root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-admin-lock-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'canonical'); mkdirSync(root);
      writeFileSync(join(root, 'example.md'), 'generic example');
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      try { await run(root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const lock = () => runPersistenceAdministration(engine, 'writer_lock', {});
const unlock = () => runPersistenceAdministration(engine, 'writer_unlock', {});
const locked = { code: 'writer_admin_locked', docs: 'docs/guides/write-refusals.md#writer_admin_locked' };
async function expectLocked(run: Promise<unknown>) {
  const error = await run.then(() => null, failure => failure as { code: string; suggestion: string; docs: string });
  expect(error).toMatchObject(locked);
  expect(error!.suggestion).toContain('Stop.');
  expect(error!.suggestion).toContain('ask the operator');
  expect(error!.suggestion).toContain('docs/guides/write-refusals.md#writer_admin_locked');
  expect(error!.suggestion).not.toMatch(/unlock/i);
}
async function captureConfig(args: string[]) {
  const errors: string[] = [];
  let exit = null as number | null;
  const errorSpy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  try { await runConfig(engine, args); }
  catch (error) { if (!(error as Error).message.startsWith('EXIT:')) throw error; }
  finally { errorSpy.mockRestore(); logSpy.mockRestore(); exitSpy.mockRestore(); }
  return { errors, exit };
}

test('claim, activate, transfer prepare and accept refuse while locked, for reviewed and internal callers', () => fixture(async root => {
  await lock();
  await expectLocked(runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') }));
  await expectLocked(runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, dry_run: true }));
  await expectLocked(claimWorktree(engine, 'default', root));
  expect(await engine.executeRaw('SELECT id FROM persistence_worktrees')).toEqual([]);

  await unlock();
  expect(await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') }))
    .toMatchObject({ claimed: true, binding: { owner_host_id: localHostId() } });

  await lock();
  await expectLocked(runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') }));
  await expectLocked(activatePersistence(engine, { confirmQuiesced: true }));
  expect(await engine.executeRaw('SELECT enabled FROM persistence_brain')).toEqual([{ enabled: false }]);
  await expectLocked(runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'default', ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }));
  await expectLocked(prepareWriterTransfer(engine, 'default'));
  expect(await engine.executeRaw('SELECT state,manifest FROM persistence_worktrees')).toEqual([{ state: 'active', manifest: null }]);

  await unlock();
  const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'default', ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as { owner_epoch: string; manifest: { digest: string } };
  // A lock row written while the transfer was pending (for example by an out-of-band write) still blocks accept.
  await engine.setConfig(LOCK_KEY, JSON.stringify({ locked: true, set_at: new Date().toISOString(), host_id: localHostId(), generation: 9 }));
  const accept = { source_id: 'default', path: root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest };
  await expectLocked(runPersistenceAdministration(engine, 'writer_transfer_accept', { ...accept, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') }));
  await expectLocked(acceptWriterTransfer(engine, 'default', root, prepared.owner_epoch, prepared.manifest.digest));
  expect(await engine.executeRaw('SELECT state,owner_epoch::text AS owner_epoch FROM persistence_worktrees')).toEqual([{ state: 'draining', owner_epoch: '1' }]);

  expect(await unlock()).toMatchObject({ changed: true, admin_lock: { locked: false, generation: 10 } });
  expect(await runPersistenceAdministration(engine, 'writer_transfer_accept', { ...accept, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') }))
    .toMatchObject({ transferred: true });
  expect(await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') }))
    .toMatchObject({ activated: true });
}), 120_000);

test('lock and unlock are idempotent and writer status reports the lock, selected host and local host id', () => fixture(async () => {
  const before = await runPersistenceAdministration(engine, 'writer_status', {});
  expect(before).toMatchObject({ admin_lock: { locked: false, set_at: null, host_id: null } });
  const first = await lock() as { changed: boolean; admin_lock: { locked: boolean; set_at: string; host_id: string; generation: number } };
  expect(first).toMatchObject({ changed: true, admin_lock: { locked: true, host_id: localHostId(), generation: 1 } });
  expect(Number.isNaN(Date.parse(first.admin_lock.set_at))).toBe(false);
  expect(await lock()).toMatchObject({ changed: false, admin_lock: first.admin_lock });
  const status = await runPersistenceAdministration(engine, 'writer_status', {});
  expect(status).toMatchObject({ local_host_id: localHostId(), admin_lock: { locked: true, set_at: first.admin_lock.set_at, host_id: localHostId() } });
  // The lock is not part of the reviewed topology fingerprint: relocking never invalidates a reviewed state.
  expect(status.admin_state).toBe(before.admin_state);
  expect(await unlock()).toMatchObject({ changed: true, admin_lock: { locked: false, generation: 2 } });
  expect(await unlock()).toMatchObject({ changed: false, admin_lock: { locked: false, generation: 2 } });
  expect(parsePersistenceAdminArgs('writer', ['lock', '--json'])).toMatchObject({ operation: 'writer_lock', json: true });
  expect(parsePersistenceAdminArgs('writer', ['unlock'])).toMatchObject({ operation: 'writer_unlock' });
  await expect(runPersistenceAdministration(engine, 'writer_lock', { force: true })).rejects.toMatchObject({ code: 'invalid_params' });
  for (const phrase of ['claim, activate and transfer', 'ordinary writes continue', 'There is no --force', 'not a security boundary',
    'Binaries older than this release do not consult the lock']) expect(WRITER_HELP).toContain(phrase);
}), 120_000);

test('lock refuses while a transfer is prepared and not yet accepted', () => fixture(async root => {
  await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
  await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'default', ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') });
  await expect(lock()).rejects.toMatchObject({ code: 'writer_transfer_conflict' });
  expect(await engine.getConfig(LOCK_KEY)).toBeNull();
}), 120_000);

test('remote callers can neither lock nor unlock', () => fixture(async () => {
  const stdio = await registerLocalWriter(engine, 'stdio');
  await expect(withVerifiedLocalRegistration(engine, stdio, () => lock())).rejects.toMatchObject({ code: 'permission_denied' });
  await lock();
  await expect(withVerifiedLocalRegistration(engine, stdio, () => unlock())).rejects.toMatchObject({ code: 'permission_denied' });
  for (const name of ['writer_lock', 'writer_unlock']) {
    const remote = await dispatchToolCall(engine, name, {}, { remote: true, sourceId: 'default', config: { engine: 'pglite' } });
    expect(remote.isError).toBe(true);
    expect(JSON.parse(remote.content[0].text)).toMatchObject({ error: 'unknown_tool' });
  }
  expect(JSON.parse((await engine.getConfig(LOCK_KEY))!)).toMatchObject({ locked: true });
}), 120_000);

test('config set, unset and prefix unset refuse the reserved lock key', () => fixture(async () => {
  await lock();
  const value = await engine.getConfig(LOCK_KEY);
  for (const args of [
    ['set', LOCK_KEY, '{"locked":false}'],
    ['set', LOCK_KEY, '{"locked":false}', '--force'],
    ['unset', LOCK_KEY],
    ['unset', '--pattern', 'persistence.'],
    ['unset', '--pattern', 'persistence.writer_admin'],
  ]) {
    const result = await captureConfig(args);
    expect(result.exit).toBe(1);
    expect(result.errors.join('\n')).toContain(`${LOCK_KEY} is reserved`);
  }
  expect(await engine.getConfig(LOCK_KEY)).toBe(value);
  await engine.setConfig('persistence.receipt_retention_days', '30');
  expect((await captureConfig(['unset', '--pattern', 'persistence.receipt'])).exit).toBeNull();
  expect(await engine.getConfig('persistence.receipt_retention_days')).toBeNull();
}), 120_000);

test('the automatic first write to an unbound PGLite source still claims while locked', () => fixture(async root => {
  await lock();
  const ctx: OperationContext = { engine, config: { engine: 'pglite', embedding_disabled: true }, remote: false, dryRun: false,
    sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  const receipt = await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/example', content: '# Generic example' }, waitMs: 10_000 });
  expect(receipt).toMatchObject({ state: 'committed' });
  expect(await engine.executeRaw('SELECT source_id FROM persistence_source_bindings')).toEqual([{ source_id: 'default' }]);

  // Managed persistence: an explicit claim of another source refuses inside the lifecycle transaction,
  // while the ordinary first write to that source still claims it automatically.
  const second = join(root, '..', 'second'); mkdirSync(second);
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('second-example','Second example')");
  await unlock();
  await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') });
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw("UPDATE sources SET local_path=$1 WHERE id='second-example'", [second]);
  });
  await lock();
  await expectLocked(claimWorktree(engine, 'second-example', second));
  expect(await engine.executeRaw("SELECT source_id FROM persistence_source_bindings WHERE source_id='second-example'")).toEqual([]);
  const managed = await submitPageMutation({ ...ctx, sourceId: 'second-example' },
    { operation: 'put_page', params: { slug: 'notes/second', content: '# Second example' }, waitMs: 10_000 });
  expect(managed).toMatchObject({ state: 'committed' });
  expect(await engine.executeRaw("SELECT source_id FROM persistence_source_bindings WHERE source_id='second-example'")).toEqual([{ source_id: 'second-example' }]);
}), 120_000);
