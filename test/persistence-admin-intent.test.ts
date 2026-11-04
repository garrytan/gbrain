import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { localHostId, persistenceHome, registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { requestPersistenceAdministration, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';

test('bind-existing rejects stale state and missing intent', () => fixture(async root => {
  const registration = await registerLocalWriter(engine, 'cli');
  const params = { source_id: 'bind-fixture', path: root, worktree_id: randomUUID(), reservation_file: join(root, '..', '.gbrain-owner-fixture.json'), expected_epoch: '1', expected_generation: '8', request_id: randomUUID() };
  await withVerifiedLocalRegistration(engine, registration, async () => {
    await expect(runPersistenceAdministration(engine, 'writer_bind_existing', params)).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
    await expect(runPersistenceAdministration(engine, 'writer_bind_existing', { ...params, admin_intent: 'writer_bind_existing', expected_state: '0'.repeat(64), expect: '1'.repeat(64) })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  });
  expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
}));

test('bind-existing parser keeps explicit flags and rejects force or duplicates', () => {
  const parsed = parsePersistenceAdminArgs('writer', ['bind-existing', 'bind-fixture', '--path', '/fixture/root', '--worktree-id', '123e4567-e89b-42d3-a456-426614174000', '--reservation-file', '/fixture/record', '--expected-epoch', '1', '--expected-generation', '8', '--request-id', '123e4567-e89b-42d3-a456-426614174001', '--dry-run']);
  expect(parsed).toMatchObject({ operation: 'writer_bind_existing', params: { source_id: 'bind-fixture', path: '/fixture/root', reservation_file: '/fixture/record', expected_epoch: '1', expected_generation: '8', dry_run: true } });
  expect(() => parsePersistenceAdminArgs('writer', ['bind-existing', 'bind-fixture', '--force'])).toThrow();
  expect(() => parsePersistenceAdminArgs('writer', ['bind-existing', 'bind-fixture', '--worktree-id', 'one', '--worktree-id', 'two'])).toThrow();
});

test('preview refuses without resident before engine creation', () => {
  const home = mkdtempSync(join(tmpdir(), 'bind-no-resident-')), database = join(home, 'datastore');
  try {
    const configDir = join(home, '.gbrain'); mkdirSync(configDir);
    const config = JSON.stringify({ engine: 'pglite', database_path: database }); writeFileSync(join(configDir, 'config.json'), config);
    const result = spawnSync(process.execPath, ['--no-env-file', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'sources', 'writer', 'bind-existing', 'bind-fixture', '--path', join(home, 'root'), '--worktree-id', randomUUID(), '--reservation-file', join(home, 'record'), '--expected-epoch', '1', '--expected-generation', '8', '--request-id', randomUUID(), '--dry-run', '--json'],
      { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GBRAIN_HOME: home, NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(result.status).not.toBe(0); expect(result.stdout + result.stderr).toContain('owner_unavailable');
    expect(existsSync(database)).toBe(false); expect(existsSync(join(configDir, 'persistence'))).toBe(false); expect(existsSync(join(configDir, 'notices'))).toBe(false);
    expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(config);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);

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
  const home = mkdtempSync(join(tmpdir(), 'gbrain-admin-intent-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'canonical'); mkdirSync(root);
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      try { await run(root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function expectRacedTopologyRejection(operation: 'writer_claim' | 'writer_transfer_prepare' | 'writer_transfer_accept',
  params: Record<string, unknown>, roots: string[]) {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw("INSERT INTO sources(id,name) VALUES('unrelated-example','Unrelated example')");
  });
  const intent = await reviewedWriterIntent(engine, operation);
  const snapshot = async () => ({
    worktrees: await engine.executeRaw('SELECT * FROM persistence_worktrees ORDER BY id'),
    bindings: await engine.executeRaw('SELECT * FROM persistence_source_bindings ORDER BY source_id'),
    hosts: await engine.executeRaw('SELECT * FROM persistence_host_bindings ORDER BY worktree_id,host_id'),
    receipts: await engine.executeRaw('SELECT * FROM persistence_topology_changes ORDER BY id'),
    markers: roots.flatMap(root => [join(root, PHYSICAL_ROOT_MARKER), physicalRootReservationPath(root), join(root, '.gbrain-managed')])
      .map(path => ({ path, contents: existsSync(path) ? readFileSync(path, 'utf8') : null })),
  });
  const before = await snapshot();
  let raced = false;
  let racedState: string | undefined;
  const proxy = new Proxy(engine, { get(target, property) {
    if (property === 'transaction') return async (run: (tx: BrainEngine) => Promise<unknown>) => {
      if (!raced) {
        raced = true;
        expect(await writerAdminState(target)).toBe(intent.expected_state);
        await target.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
          await tx.executeRaw("UPDATE sources SET archived=true WHERE id='unrelated-example'");
        });
        racedState = await writerAdminState(target);
        expect(racedState).not.toBe(intent.expected_state);
        expect(await snapshot()).toEqual(before);
      }
      return target.transaction(run);
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
  await expect(runPersistenceAdministration(proxy, operation, { ...params, ...intent })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  expect(raced).toBe(true);
  expect(racedState).toBe(await writerAdminState(engine));
  expect(await engine.executeRaw("SELECT archived FROM sources WHERE id='unrelated-example'")).toEqual([{ archived: true }]);
  expect(await snapshot()).toEqual(before);
}

test('status, probe, dry runs and routine flags never create ownership or host identity', () => fixture(async root => {
  const initial = await writerAdminState(engine);
  expect(await runPersistenceAdministration(engine, 'writer_status', { probe: true })).toMatchObject({ enabled: false, host_id: null, admin_state: initial });
  expect(await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, dry_run: true })).toMatchObject({ dry_run: true, current: null });
  await expect(runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, dry_run: true })).rejects.toMatchObject({ code: 'writer_registration_required' });
  for (const [operation, params] of [
    ['writer_claim', { source_id: 'default', path: root }],
    ['writer_activate', { confirm_quiesced: true }],
    ['writer_transfer_prepare', { source_id: 'default' }],
    ['writer_transfer_accept', { source_id: 'default', path: root, expected_epoch: '1', manifest: 'a'.repeat(64) }],
  ] as const) {
    await expect(runPersistenceAdministration(engine, operation, params)).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
    await expect(runPersistenceAdministration(engine, operation, { ...params, admin_intent: true, expected_state: initial })).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
    await expect(runPersistenceAdministration(engine, operation, { ...params, admin_intent: 'wrong_action', expected_state: initial })).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
  }
  expect(() => parsePersistenceAdminArgs('writer', ['activate', '--confirm-quiesced', '--yes'])).toThrow('Unknown administration option');
  expect(await writerAdminState(engine)).toBe(initial);
  expect(existsSync(join(persistenceHome(), 'host.json'))).toBe(false);
  expect((await engine.executeRaw('SELECT id FROM persistence_worktrees')).length).toBe(0);
}));

test('deliberate claim, activate and transfer require fresh state while preserving existing identity', () => fixture(async root => {
  writeFileSync(join(root, 'example.md'), 'generic example');
  const host = localHostId();
  const identity = readFileSync(join(persistenceHome(), 'host.json'), 'utf8');
  const oldActivation = await reviewedWriterIntent(engine, 'writer_activate');
  expect(await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') })).toMatchObject({ claimed: true, binding: { owner_host_id: host } });
  await expect(runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...oldActivation })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  expect(await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') })).toMatchObject({ activated: true });
  await expect(runPersistenceAdministration(engine, 'source_lifecycle', { action: 'claim', source_id: 'default', path: root })).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
  const beforePrepare = await reviewedWriterIntent(engine, 'writer_transfer_accept');
  const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'default', ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as { owner_epoch: string; manifest: { digest: string } };
  const accept = { source_id: 'default', path: root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest };
  await expect(runPersistenceAdministration(engine, 'writer_transfer_accept', { ...accept, ...beforePrepare })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  const deliberate = { ...accept, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') };
  const accepted = await runPersistenceAdministration(engine, 'writer_transfer_accept', deliberate) as { transferred: boolean; binding: { owner_epoch: string | number } };
  expect(accepted.transferred).toBe(true);
  expect(String(accepted.binding.owner_epoch)).toBe('2');
  await expect(runPersistenceAdministration(engine, 'writer_transfer_accept', deliberate)).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  expect(readFileSync(join(persistenceHome(), 'host.json'), 'utf8')).toBe(identity);
}));

test('a state change after preflight is rechecked before the claim transaction writes ownership', () => fixture(async root => {
  const intent = await reviewedWriterIntent(engine, 'writer_claim');
  let raced = false;
  const proxy = new Proxy(engine, { get(target, property) {
    if (property === 'transaction') return async (run: (tx: BrainEngine) => Promise<unknown>) => {
      if (!raced) { raced = true; await target.executeRaw('UPDATE sources SET incarnation=gen_random_uuid() WHERE id=$1', ['default']); }
      return target.transaction(run);
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
  await expect(runPersistenceAdministration(proxy, 'writer_claim', { source_id: 'default', path: root, ...intent })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  expect(raced).toBe(true);
  expect(await engine.executeRaw('SELECT id FROM persistence_worktrees')).toEqual([]);
}));

test('activation rechecks raced state before enabling or registering writers', () => fixture(async root => {
  await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
  const intent = await reviewedWriterIntent(engine, 'writer_activate');
  let raced = false;
  const proxy = new Proxy(engine, { get(target, property) {
    if (property === 'transaction') return async (run: (tx: BrainEngine) => Promise<unknown>) => {
      if (!raced) { raced = true; await target.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1'); }
      return target.transaction(run);
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
  await expect(runPersistenceAdministration(proxy, 'writer_activate', { confirm_quiesced: true, ...intent })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
  expect(await engine.executeRaw('SELECT enabled FROM persistence_brain')).toEqual([{ enabled: false }]);
  expect(await engine.executeRaw('SELECT id FROM persistence_local_writers')).toEqual([]);
}));

test('transfer preparation rechecks raced topology before changing transfer state or markers', () => fixture(async root => {
  writeFileSync(join(root, 'example.md'), 'generic example');
  await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
  expect(await engine.executeRaw('SELECT owner_host_id,owner_epoch::text,state,manifest FROM persistence_worktrees'))
    .toEqual([{ owner_host_id: localHostId(), owner_epoch: '1', state: 'active', manifest: null }]);
  await expectRacedTopologyRejection('writer_transfer_prepare', { source_id: 'default' }, [root]);
  expect(await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'default', ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') })).toMatchObject({ prepared: true, owner_epoch: '1' });
}));

test('transfer acceptance rechecks raced topology despite an unchanged prepared epoch and manifest', () => fixture(async root => {
  const successor = join(root, '..', 'successor'); mkdirSync(successor);
  for (const path of [root, successor]) writeFileSync(join(path, 'example.md'), 'generic example');
  await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
  const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'default', ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as { owner_epoch: string; manifest: { digest: string } };
  expect(await engine.executeRaw("SELECT owner_host_id,owner_epoch::text,state,manifest->>'digest' AS digest FROM persistence_worktrees"))
    .toEqual([{ owner_host_id: localHostId(), owner_epoch: prepared.owner_epoch, state: 'draining', digest: prepared.manifest.digest }]);
  for (const path of [join(successor, PHYSICAL_ROOT_MARKER), physicalRootReservationPath(successor), join(successor, '.gbrain-managed')]) expect(existsSync(path)).toBe(false);
  const params = { source_id: 'default', path: successor, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest };
  await expectRacedTopologyRejection('writer_transfer_accept', params, [root, successor]);
  expect(await runPersistenceAdministration(engine, 'writer_transfer_accept', { ...params, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') }))
    .toMatchObject({ transferred: true, binding: { local_path: successor, owner_host_id: localHostId(), state: 'active' } });
  expect(await engine.executeRaw('SELECT owner_epoch::text FROM persistence_worktrees')).toEqual([{ owner_epoch: '2' }]);
}));

test('managed claim rechecks raced topology before creating ownership, a receipt or markers', () => fixture(async root => {
  const candidate = join(root, '..', 'candidate'); mkdirSync(candidate);
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('candidate-example','Candidate example')");
  await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
  expect(await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') })).toMatchObject({ activated: true });
  expect(await engine.executeRaw("SELECT source_id FROM persistence_source_bindings WHERE source_id='candidate-example'")).toEqual([]);
  for (const path of [join(candidate, PHYSICAL_ROOT_MARKER), physicalRootReservationPath(candidate), join(candidate, '.gbrain-managed')]) expect(existsSync(path)).toBe(false);
  await expectRacedTopologyRejection('writer_claim', { source_id: 'candidate-example', path: candidate }, [root, candidate]);
  expect(await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'candidate-example', path: candidate, ...await reviewedWriterIntent(engine, 'writer_claim') }))
    .toMatchObject({ claimed: true, binding: { source_id: 'candidate-example', owner_host_id: localHostId(), local_path: candidate } });
}));

test('provider startup, remote lane forgery and remote intent cannot change writer topology', () => fixture(async root => {
  const host = localHostId();
  await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
  const before = await writerAdminState(engine);
  const provider = await createPersistenceIpcProvider(engine, { engine: 'pglite', embedding_disabled: true });
  expect(await writerAdminState(engine)).toBe(before);
  expect(localHostId()).toBe(host);
  const stdio = await registerLocalWriter(engine, 'stdio');
  const params = { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') };
  await expect(withVerifiedLocalRegistration(engine, stdio, () => runPersistenceAdministration(engine, 'writer_claim', params))).rejects.toMatchObject({ code: 'permission_denied' });
  const socketDir = process.env.GBRAIN_TEST_IPC_DIR ? mkdtempSync(join(process.env.GBRAIN_TEST_IPC_DIR, 'i')) : root;
  const ipc = (await startPersistenceIpcServer(join(socketDir, 's'), provider))!;
  const request = { version: 1 as const, kind: 'administration' as const, brain_id: provider.brainId, registration: stdio, operation: 'writer_claim' as const, params };
  try {
    if (process.env.GBRAIN_TEST_IPC_DIR) expect(ipc.socketPath).toBe(join(socketDir, 's'));
    await expect(requestPersistenceAdministration(ipc.socketPath, request)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(requestPersistenceAdministration(ipc.socketPath, { ...request, registration: { ...stdio, lane: 'cli' } })).rejects.toMatchObject({ code: 'permission_denied' });
  } finally {
    const closed = once(ipc.server, 'close'); ipc.close(); await closed;
    if (socketDir !== root) rmSync(socketDir, { recursive: true, force: true });
  }
  const remote = await dispatchToolCall(engine, 'writer_claim', params, { remote: true, sourceId: 'default', config: { engine: 'pglite' } });
  expect(remote.isError).toBe(true);
  expect(JSON.parse(remote.content[0].text)).toMatchObject({ error: 'unknown_tool' });
  const { operationsByName } = await import('../src/core/operations.ts');
  for (const name of ['writer_claim', 'writer_activate', 'writer_transfer_prepare', 'writer_transfer_accept']) expect(operationsByName[name]).toBeUndefined();
  expect(await writerAdminState(engine)).toBe(before);
}));
