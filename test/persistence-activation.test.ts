import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acceptWriterTransfer, acquireWorktree, claimWorktree, managedPersistenceEnabled, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { registerManagedFilesystemEngine } from '../src/core/persistence/filesystem-guard.ts';
import { registeredManagedRoots } from '../src/core/persistence/root-registry.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { persistenceSocketPathForConfig, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';

let memoryEngine: PGLiteEngine;
let diskEngine: PGLiteEngine;
let schemaVersion: string;
const diskHome = mkdtempSync(join(tmpdir(), 'gbrain-activation-disk-'));
beforeAll(async () => {
  memoryEngine = new PGLiteEngine();
  await memoryEngine.connect({}); await memoryEngine.initSchema();
  schemaVersion = (await memoryEngine.getConfig('version'))!;
  await withEnv({ GBRAIN_HOME: diskHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    diskEngine = new PGLiteEngine();
    await diskEngine.connect({ database_path: join(diskHome, 'db') }); await diskEngine.initSchema();
  });
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(memoryEngine); await memoryEngine.disconnect();
  await disposePersistenceConsumer(diskEngine); await diskEngine.disconnect();
  rmSync(diskHome, { recursive: true, force: true });
});
async function fixture(run: (engine: PGLiteEngine, root: string, home: string, sourceId: string) => Promise<void>, disk = false) {
  const home = disk ? diskHome : mkdtempSync(join(tmpdir(), 'gbrain-activation-'));
  const root = join(home, 'canonical'); mkdirSync(root);
  const engine = disk ? diskEngine : memoryEngine;
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await disposePersistenceConsumer(engine); await resetPgliteState(engine); await engine.setConfig('version', schemaVersion);
      const sourceId = `activate-${randomUUID().slice(0, 12)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      try { await run(engine, root, home, sourceId); }
      finally { await disposePersistenceConsumer(engine); }
    });
  } finally { if (!disk) rmSync(home, { recursive: true, force: true }); }
}

test('activation requires explicit quiescence and a complete owner binding without silently claiming', () => fixture(async (engine, root, _home, sourceId) => {
  await expect(activatePersistence(engine)).rejects.toMatchObject({ code: 'writer_not_quiesced' });
  await expect(activatePersistence(engine, { confirmQuiesced: true })).rejects.toMatchObject({ code: 'writer_registration_required' });
  expect(await managedPersistenceEnabled(engine)).toBe(false);
  expect(await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', [sourceId])).toEqual([]);
  await claimWorktree(engine, sourceId, root);
  expect(await activatePersistence(engine, { confirmQuiesced: true, dryRun: true })).toMatchObject({ enabled: false, activated: false, filesystem_sources: 1 });
  expect(await managedPersistenceEnabled(engine)).toBe(false);
}), 60_000);

test('activation refuses busy native roots and even expired legacy leases', () => fixture(async (engine, root, _home, sourceId) => {
  const binding = await claimWorktree(engine, sourceId, root);
  const lock = (await acquireWorktree(binding))!;
  try { await expect(activatePersistence(engine, { confirmQuiesced: true })).rejects.toMatchObject({ code: 'writer_not_quiesced' }); }
  finally { await lock.release(); }
  await engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,last_refreshed_at,acquisition_token)
    VALUES('legacy-sync',999999,'other-host',now()-interval '1 hour',now()-interval '30 minutes',now()-interval '1 hour',$1::uuid)`, [randomUUID()]);
  await expect(activatePersistence(engine, { confirmQuiesced: true })).rejects.toMatchObject({ code: 'writer_not_quiesced' });
  expect(await managedPersistenceEnabled(engine)).toBe(false);
}), 60_000);

test('activation fsyncs source and selected datastore refusal records before becoming visible', () => fixture(async (engine, root, home, sourceId) => {
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [`${sourceId}-later`]);
  const selected = join(home, 'selected-datastore'); mkdirSync(selected);
  await registerManagedFilesystemEngine(engine, selected);
  await registerLocalWriter(engine, 'cli');
  expect(await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') })).toMatchObject({ enabled: true, activated: true });
  expect(registeredManagedRoots()).toContain(root);
  expect(registeredManagedRoots()).toContain(selected);
  expect(JSON.parse(readFileSync(join(root, '.gbrain-managed'), 'utf8'))).toMatchObject({ managed: true, version: 1 });
  expect(await managedPersistenceEnabled(engine)).toBe(true);
  await expect(engine.putPage('legacy', { type: 'note', title: 'Example', compiled_truth: 'Unsupported legacy write', timeline: '', frontmatter: {} }, { sourceId })).rejects.toThrow('writer_coordinator_required');
  expect(await activatePersistence(engine, { confirmQuiesced: true })).toMatchObject({ enabled: true, activated: false });
  const later = join(home, 'later-canonical'); mkdirSync(later);
  await claimWorktree(engine, `${sourceId}-later`, later);
  expect(registeredManagedRoots()).toContain(later);
  const successor = join(home, 'successor'); cpSync(root, successor, { recursive: true });
  const transfer = await prepareWriterTransfer(engine, sourceId);
  await acceptWriterTransfer(engine, sourceId, successor, transfer.owner_epoch, transfer.manifest.digest);
  expect(registeredManagedRoots()).toContain(successor);
}), 60_000);

test('a refusal-registry write failure rolls back activation and releases native roots', () => fixture(async (engine, root, home, sourceId) => {
  const binding = await claimWorktree(engine, sourceId, root);
  const directory = join(home, '.gbrain', 'persistence'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'managed-roots'), 'cannot create a registry directory here');
  await expect(activatePersistence(engine, { confirmQuiesced: true })).rejects.toThrow();
  expect(await managedPersistenceEnabled(engine)).toBe(false);
  const lock = await acquireWorktree(binding);
  expect(lock).not.toBeNull(); await lock?.release();
}), 60_000);

test('activation is a private administration command and rejects ambiguous intent flags', async () => {
  expect(parsePersistenceAdminArgs('writer', ['activate', '--confirm-quiesced', '--dry-run', '--json'])).toMatchObject({
    operation: 'writer_activate', params: { confirm_quiesced: true, dry_run: true }, json: true,
  });
  expect(() => parsePersistenceAdminArgs('writer', ['activate', '--confirm-quiesced=false'])).toThrow('does not accept a value');
  const { operationsByName } = await import('../src/core/operations.ts');
  expect(operationsByName.writer_activate).toBeUndefined();
});

test('actual CLI activation delegates through the verified owner while disk PGLite remains open', () => fixture(async (engine, root, home, sourceId) => {
  await claimWorktree(engine, sourceId, root);
  const config = { engine: 'pglite' as const, database_path: join(home, 'db'), embedding_disabled: true };
  const metadata = join(config.database_path, '.gbrain-lock', 'lock');
  writeFileSync(metadata, JSON.stringify({ ...JSON.parse(readFileSync(metadata, 'utf8')), subcommand: 'serve' }));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
  const provider = await createPersistenceIpcProvider(engine, config);
  const ipc = (await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, provider))!;
  try {
    const intent = await reviewedWriterIntent(engine, 'writer_activate');
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'sources', 'writer', 'activate', '--confirm-quiesced', '--admin-intent', intent.admin_intent, '--expected-state', String(intent.expected_state), '--json'], {
      cwd: home, env: { ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(stdout)).toMatchObject({ enabled: true, activated: true, filesystem_sources: 1 });
    expect(await managedPersistenceEnabled(engine)).toBe(true);
  } finally { const closed = once(ipc.server, 'close'); ipc.close(); await closed; }
}, true), 60_000);
