import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readLocalWriter, registerLocalWriter, revokeLocalWriter, verifyLocalWriter, persistenceHome } from '../src/core/persistence/identity.ts';
import { startPersistenceIpcServer, requestPersistenceAdministration, requestPersistenceCapabilities, persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainId: string;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  [ { brain_id: brainId } ] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
}, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

async function isolated<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-admin-test-'));
  try {
    return await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => run(dir));
  } finally { await disposePersistenceConsumer(engine); rmSync(dir, { force: true, recursive: true }); }
}

describe('local writer administration', () => {
  test('registration grants validate and replacement revokes the old credential without returning secrets', () => isolated(async () => {
    const first = await runPersistenceAdministration(engine, 'local_writer_register', { lane: 'cli' });
    const old = await readLocalWriter(engine, 'cli');
    await expect(runPersistenceAdministration(engine, 'local_writer_register', { lane: 'cli', allowed_operations: ['get_page'] })).rejects.toMatchObject({ code: 'writer_regrant_required' });
    const second = await runPersistenceAdministration(engine, 'local_writer_register', { lane: 'cli', replace: true, allowed_operations: ['get_page'] });
    expect(second.id).not.toBe(first.id);
    await expect(verifyLocalWriter(engine, old)).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await readLocalWriter(engine, 'cli')).id).toBe(second.id as string);
    const listed = await runPersistenceAdministration(engine, 'local_writer_list', { limit: 1000 });
    expect(JSON.stringify([first, second, listed])).not.toContain(old.credential);
    expect(JSON.stringify(listed)).not.toContain('credential_hash');
    const backup = readdirSync(persistenceHome()).find(name => name.includes('.cli.json.revoked.'))!;
    expect(JSON.parse(readFileSync(join(persistenceHome(), backup), 'utf8')).id).toBe(old.id);
    await expect(runPersistenceAdministration(engine, 'local_writer_register', { lane: 'stdio', scopes: ['admin'] })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(runPersistenceAdministration(engine, 'local_writer_register', { lane: 'stdio', source_ids: ['missing-source'] })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(runPersistenceAdministration(engine, 'local_writer_register', { lane: 'stdio', allowed_operations: ['writer_status'] })).rejects.toMatchObject({ code: 'invalid_params' });
  }));

  test('a failed replacement transaction preserves the original active credential file and removes its pending file', () => isolated(async () => {
    const old = await registerLocalWriter(engine, 'cli');
    const proxy = new Proxy(engine, { get(target, property) {
      if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx, {
        get(target, key) {
          if (key === 'executeRaw') return (sql: string, params: unknown[]) => {
            if (sql.includes('INSERT INTO persistence_local_writers')) throw new OperationError('storage_error', 'Simulated registration failure.');
            return target.executeRaw(sql, params);
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        },
      })));
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine;
    await expect(registerLocalWriter(proxy, 'cli', undefined, true)).rejects.toMatchObject({ code: 'storage_error' });
    expect(await readLocalWriter(engine, 'cli')).toEqual(old);
    expect((await verifyLocalWriter(engine, old)).principal.id).toBe(old.id);
    expect(readdirSync(persistenceHome()).filter(name => name.includes('.pending.'))).toEqual([]);
  }));

  test('concurrent explicit replacements serialize and the published credential is the only live successor', () => isolated(async () => {
    const old = await registerLocalWriter(engine, 'cli');
    const successors = await Promise.all([registerLocalWriter(engine, 'cli', undefined, true), registerLocalWriter(engine, 'cli', undefined, true)]);
    const active = await readLocalWriter(engine, 'cli');
    expect(successors.map(value => value.id)).toContain(active.id);
    const rows = await engine.executeRaw('SELECT id FROM persistence_local_writers WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL', [[old.id, ...successors.map(value => value.id)]]);
    expect(rows).toEqual([{ id: active.id }]);
  }));

  test('claim and transfer require matching bytes and epoch; a real native probe acquires and releases', () => isolated(async dir => {
    const sourceId = `admin-${randomUUID().slice(0, 8)}`;
    const initial = join(dir, 'initial'), successor = join(dir, 'successor');
    mkdirSync(initial); mkdirSync(successor);
    writeFileSync(join(initial, 'page.md'), 'canonical bytes');
    writeFileSync(join(successor, 'page.md'), 'different bytes');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, initial]);
    const claim = await runPersistenceAdministration(engine, 'writer_claim', { source_id: sourceId, path: initial });
    expect(claim.claimed).toBe(true);
    const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: sourceId }) as any;
    await expect(runPersistenceAdministration(engine, 'writer_transfer_accept', {
      source_id: sourceId, path: successor, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest,
    })).rejects.toMatchObject({ code: 'writer_manifest_mismatch' });
    writeFileSync(join(successor, 'page.md'), 'canonical bytes');
    await expect(runPersistenceAdministration(engine, 'writer_transfer_accept', {
      source_id: sourceId, path: successor, expected_epoch: '99', manifest: prepared.manifest.digest,
    })).rejects.toMatchObject({ code: 'writer_transfer_conflict' });
    const accepted = await runPersistenceAdministration(engine, 'writer_transfer_accept', {
      source_id: sourceId, path: successor, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest,
    }) as any;
    expect(accepted.binding.local_path).toBe(successor);
    expect(String(accepted.binding.owner_epoch)).toBe('2');
    const status = await runPersistenceAdministration(engine, 'writer_status', { probe: true });
    expect(status.native_lock).toMatchObject({ napi: 3, acquired: true, released: true });
  }));

  test('private IPC rejects stdio, lane forgery, revoked credentials, and wire trust assertions', () => isolated(async dir => {
    const config = { engine: 'pglite' as const, database_path: join(dir, 'db') };
    const provider = await createPersistenceIpcProvider(engine, config);
    const cli = await readLocalWriter(engine, 'cli'), stdio = await readLocalWriter(engine, 'stdio');
    const binding = (await startPersistenceIpcServer(join(dir, 'administration.sock'), provider))!;
    const request = { version: 1 as const, kind: 'administration' as const, brain_id: brainId,
      operation: 'local_writer_list' as const, params: {}, registration: cli };
    try {
      expect((await requestPersistenceCapabilities(binding.socketPath)).administration).toContain('writer_status');
      expect(await requestPersistenceAdministration(binding.socketPath, request)).toHaveProperty('writers');
      await expect(requestPersistenceAdministration(binding.socketPath, { ...request, registration: stdio })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(requestPersistenceAdministration(binding.socketPath, { ...request, registration: { ...stdio, lane: 'cli' } })).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(requestPersistenceAdministration(binding.socketPath, { ...request, remote: false } as any)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(requestPersistenceAdministration(binding.socketPath, { ...request, params: { remote: false } })).rejects.toMatchObject({ code: 'invalid_params' });
      await revokeLocalWriter(engine, cli.id);
      await expect(requestPersistenceAdministration(binding.socketPath, request)).rejects.toMatchObject({ code: 'permission_denied' });
      await expect(provider.administer!({ ...request, operation: 'local_writer_register', params: { lane: 'cli', replace: true } })).rejects.toMatchObject({ code: 'permission_denied' });
    } finally { const closed = once(binding.server, 'close'); binding.close(); await closed; }
  }));

  test('actual CLI status/probe, registrations and dry-run claim delegate while PGLite ownership is held', () => isolated(async dir => {
    const config = { engine: 'pglite' as const, database_path: join(dir, 'db') };
    mkdirSync(config.database_path);
    const lock = await acquireLock(config.database_path);
    const metadata = lock.lockPath ?? join(config.database_path, '.gbrain-lock', 'lock');
    writeFileSync(metadata, JSON.stringify({ ...JSON.parse(readFileSync(metadata, 'utf8')), subcommand: 'serve' }));
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
    const provider = await createPersistenceIpcProvider(engine, config);
    const binding = (await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, provider))!;
    try {
      for (const args of [
        ['sources', 'writer', 'status', '--probe', '--json'],
        ['auth', 'local-writer', 'list', '--json'],
        ['sources', 'writer', 'claim', 'default', '--path', dir, '--dry-run', '--json'],
      ]) {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
          cwd: dir, env: { ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' }, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toMatchObject({ code: 0 });
        const result = JSON.parse(stdout);
        if (args.includes('--probe')) expect(result.native_lock).toMatchObject({ acquired: true, released: true });
        else if (args.includes('--dry-run')) expect(result.dry_run).toBe(true);
        else expect(result).toHaveProperty('writers');
      }
    } finally { const closed = once(binding.server, 'close'); binding.close(); await closed; await releaseLock(lock); }
  }));

  test('CLI parser preserves exact grant/epoch intent and rejects malformed flag combinations', () => {
    expect(parsePersistenceAdminArgs('local-writer', ['register', 'stdio', '--allowed-operations=', '--source-ids', 'default', '--replace'])).toMatchObject({
      operation: 'local_writer_register', params: { lane: 'stdio', allowed_operations: [], source_ids: ['default'], replace: true },
    });
    expect(parsePersistenceAdminArgs('writer', ['transfer', 'accept', 'default', '--expected-epoch', '42', '--manifest', 'a'.repeat(64)])).toMatchObject({
      operation: 'writer_transfer_accept', params: { source_id: 'default', expected_epoch: '42' },
    });
    expect(() => parsePersistenceAdminArgs('writer', ['claim', 'default', '--source', 'other'])).toThrow('Specify the source once');
    expect(() => parsePersistenceAdminArgs('writer', ['status', '--probe=false'])).toThrow('does not accept a value');
    expect(() => parsePersistenceAdminArgs('writer', ['transfer', 'steal', 'default'])).toThrow('prepare or accept');
  });
});
