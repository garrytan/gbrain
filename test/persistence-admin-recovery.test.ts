import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { requestPersistenceAdministration, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { localHostId, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
for (const kind of backends) describe(`writer recovery (${kind})`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-admin-recovery-'));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });
  async function fixture(run: (f: { root: string; home: string; source: string; binding: NonNullable<Awaited<ReturnType<typeof getWorktreeBinding>>> }) => Promise<void>) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `recovery-${randomUUID().slice(0, 8)}`;
    writeFileSync(join(root, 'note.md'), 'Canonical example');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: source, path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
      await run({ root, home, source, binding: (await getWorktreeBinding(engine, source))! });
    });
  }
  const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
    runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
  function drift(root: string) {
    const path = join(root, PHYSICAL_ROOT_MARKER), stamp = JSON.parse(readFileSync(path, 'utf8'));
    stamp.device = String(BigInt(stamp.device) + 1n); writeFileSync(path, JSON.stringify(stamp));
  }
  for (const damage of ['device', 'reservation', 'stamp', 'both']) test(`explicit self-transfer repairs ${damage} and preserves strict ordinary checks`, () => fixture(async f => {
    if (damage === 'device') drift(f.root);
    if (damage === 'reservation' || damage === 'both') rmSync(physicalRootReservationPath(f.root));
    if (damage === 'stamp' || damage === 'both') rmSync(join(f.root, PHYSICAL_ROOT_MARKER));
    await expect(acquireWorktree(f.binding)).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(administer('writer_transfer_prepare', { source_id: f.source })).rejects.toMatchObject({ code: 'recovery_required' });
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as any;
    await administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    const binding = (await getWorktreeBinding(engine, f.source))!;
    expect(binding.owner_epoch).toBe('2'); expect(binding.state).toBe('active');
    const lock = await acquireWorktree(binding); expect(lock).not.toBeNull(); await lock?.release();
  }));
  test('device drift is distinguished only when all other stamp fields match', () => fixture(async f => {
    drift(f.root);
    await expect(acquireWorktree(f.binding)).rejects.toThrow('device identifier');
    const path = join(f.root, PHYSICAL_ROOT_MARKER), stamp = JSON.parse(readFileSync(path, 'utf8'));
    stamp.token = randomUUID(); writeFileSync(path, JSON.stringify(stamp));
    await expect(acquireWorktree(f.binding)).rejects.not.toThrow('device identifier');
    await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
  }));
  test('self-transfer requires exact intent, reviewed state, root, epoch and manifest', () => fixture(async f => {
    drift(f.root);
    await expect(runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
    const before = await reviewedWriterIntent(engine, 'writer_transfer_accept');
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as any;
    const params = { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true };
    await expect(runPersistenceAdministration(engine, 'writer_transfer_accept', { ...params, ...before })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
    await expect(administer('writer_transfer_accept', { ...params, expected_epoch: '2' })).rejects.toMatchObject({ code: 'writer_transfer_conflict' });
    const other = join(f.home, 'copy'); mkdirSync(other); writeFileSync(join(other, 'note.md'), 'Canonical example');
    await expect(administer('writer_transfer_accept', { ...params, path: other })).rejects.toMatchObject({ code: 'source_changed' });
    writeFileSync(join(f.root, 'note.md'), 'Changed example');
    await expect(administer('writer_transfer_accept', params)).rejects.toMatchObject({ code: 'writer_manifest_mismatch' });
    expect((await getWorktreeBinding(engine, f.source))?.owner_epoch).toBe('1');
    const renewed = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as any;
    expect(renewed.manifest.digest).not.toBe(prepared.manifest.digest);
    expect(await administer('writer_transfer_accept', { ...params, manifest: renewed.manifest.digest })).toMatchObject({ transferred: true });
  }));
  test('dry-run leaves missing records absent and requires real native exclusion', () => fixture(async f => {
    rmSync(physicalRootReservationPath(f.root)); rmSync(join(f.root, PHYSICAL_ROOT_MARKER));
    expect(await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: f.source, self_transfer: true, dry_run: true })).toMatchObject({ dry_run: true });
    expect(existsSync(physicalRootReservationPath(f.root))).toBe(false);
    expect(existsSync(join(f.root, PHYSICAL_ROOT_MARKER))).toBe(false);
    const lock = await tryAcquireNativeLock(f.binding.coordination_path!); expect(lock).not.toBeNull();
    try { await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'write_pending' }); }
    finally { await lock?.release(); }
  }), 15_000);
  test('self-transfer refuses another host, malformed identity and post-prepare token replacement', () => fixture(async f => {
    const otherHome = join(f.home, 'other-host'); mkdirSync(otherHome);
    await withEnv({ GBRAIN_HOME: otherHome }, async () => {
      localHostId();
      await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'permission_denied' });
    });
    const marker = join(f.root, PHYSICAL_ROOT_MARKER), original = readFileSync(marker, 'utf8');
    for (const changes of [{ root: join(f.home, 'wrong-root') }, { brainId: randomUUID() }, { worktreeId: randomUUID() }, { device: 'malformed' }, { inode: '0' }]) {
      writeFileSync(marker, JSON.stringify({ ...JSON.parse(original), ...changes }));
      await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
    }
    writeFileSync(marker, original); drift(f.root);
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as any;
    const replacement = randomUUID(), reservation = physicalRootReservationPath(f.root);
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, 'utf8')), token: replacement }));
    writeFileSync(reservation, JSON.stringify({ ...JSON.parse(readFileSync(reservation, 'utf8')), token: replacement }));
    await expect(administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
  }));
  test('active publication and effect recovery prevent self-transfer', () => fixture(async f => {
    const [request] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,
      source_id,source_incarnation,slug,worktree_id,digest,authority,intent_bytes,terminal_reservation,state,publication_started)
      VALUES('local_cli','fixture',$1::uuid,'put_page',$2,$3::uuid,'note',$4::uuid,'fixture','{}'::jsonb,0,0,'running',true) RETURNING id`,
    [randomUUID(), f.source, f.binding.source_incarnation, f.binding.worktree_id]);
    try {
      await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
      await engine.executeRaw("UPDATE persistence_requests SET state='committed',publication_started=false WHERE id=$1::uuid", [request.id]);
      await engine.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,worktree_id,recovery)
        VALUES($1::uuid,'withdrawal-mirror','{}'::jsonb,$2::uuid,'{}'::jsonb)`, [request.id, f.binding.worktree_id]);
      await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
    } finally {
      await engine.executeRaw('DELETE FROM persistence_effects WHERE request_id=$1::uuid', [request.id]);
      await engine.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [request.id]);
    }
  }));
  test('a verified successor can repair its root without rewriting the original reservation host', () => fixture(async f => {
    const first = await administer('writer_transfer_prepare', { source_id: f.source }) as any;
    const otherHome = join(f.home, 'successor-home'); mkdirSync(otherHome);
    await withEnv({ GBRAIN_HOME: otherHome }, async () => {
      await administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: first.owner_epoch, manifest: first.manifest.digest });
      drift(f.root);
      const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as any;
      expect(await administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true }))
        .toMatchObject({ transferred: true, binding: { owner_epoch: '3', owner_host_id: localHostId() } });
    });
  }));
  test('a failed database commit after physical repair retains an exact retryable preparation', () => fixture(async f => {
    rmSync(physicalRootReservationPath(f.root)); rmSync(join(f.root, PHYSICAL_ROOT_MARKER));
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as any;
    const params = { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true };
    const failing = new Proxy(engine, { get(target, key) {
      if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(async tx => {
        await fn(tx); throw new Error('Interrupted after physical repair before SQL commit');
      });
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(runPersistenceAdministration(failing, 'writer_transfer_accept', { ...params, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') })).rejects.toThrow('Interrupted');
    expect((await getWorktreeBinding(engine, f.source))?.state).toBe('draining');
    expect(existsSync(physicalRootReservationPath(f.root))).toBe(true);
    expect(existsSync(join(f.root, PHYSICAL_ROOT_MARKER))).toBe(true);
    expect(await administer('writer_transfer_accept', params)).toMatchObject({ transferred: true, binding: { owner_epoch: '2' } });
    await expect(administer('writer_transfer_accept', params)).rejects.toMatchObject({ code: 'writer_transfer_conflict' });
    expect((await getWorktreeBinding(engine, f.source))?.owner_epoch).toBe('2');
  }));
  test('a durable stamp temporary left before rename resumes only with its exact prepared bytes', () => fixture(async f => {
    drift(f.root);
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as any;
    const [row] = await engine.executeRaw<{ manifest: { self_transfer: { stamp: { token: string } } } }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [f.binding.worktree_id]);
    const stamp = row.manifest.self_transfer.stamp, temporary = join(f.root, `${PHYSICAL_ROOT_MARKER}.${stamp.token}.tmp`);
    writeFileSync(temporary, JSON.stringify({ ...stamp, token: randomUUID() }), { mode: 0o600 });
    const params = { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true };
    await expect(administer('writer_transfer_accept', params)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(existsSync(temporary)).toBe(true);
    writeFileSync(temporary, JSON.stringify(stamp));
    expect(await administer('writer_transfer_accept', params)).toMatchObject({ transferred: true });
    expect(existsSync(temporary)).toBe(false);
  }));
  test('resident IPC status, claim replay and transfer retain epochs beyond safe integers', () => fixture(async f => {
    const large = '9007199254740993';
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=$1::bigint WHERE id=$2::uuid', [large, f.binding.worktree_id]);
    await engine.executeRaw('UPDATE persistence_source_bindings SET topology_generation=$1::bigint WHERE source_id=$2', [large, f.source]);
    const provider = await createPersistenceIpcProvider(engine, { engine: kind, embedding_disabled: true });
    const server = (await startPersistenceIpcServer(join(f.home, 'writer.sock'), provider))!;
    const registration = await readLocalWriter(engine, 'cli');
    const call = async (operation: 'writer_status' | 'writer_claim' | 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
      requestPersistenceAdministration(server.socketPath, { version: 1, kind: 'administration', brain_id: provider.brainId, registration, operation, params });
    try {
      const status = await call('writer_status', { source_id: f.source }) as any;
      expect(status.bindings[0]).toMatchObject({ owner_epoch: large, topology_generation: large });
      const preview = await call('writer_claim', { source_id: f.source, path: f.root, dry_run: true }) as any;
      expect(preview.current).toMatchObject({ owner_epoch: large, topology_generation: large });
      const sharedSource = `ipc-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sharedSource, f.root]);
      const newClaim = await call('writer_claim', { source_id: sharedSource, path: f.root, ...await reviewedWriterIntent(engine, 'writer_claim') }) as any;
      expect(newClaim.binding).toMatchObject({ source_id: sharedSource, owner_epoch: large, topology_generation: '1' });
      const claimed = await call('writer_claim', { source_id: f.source, path: f.root, ...await reviewedWriterIntent(engine, 'writer_claim') }) as any;
      expect(claimed.binding.owner_epoch).toBe(large);
      const transferPreview = await call('writer_transfer_prepare', { source_id: f.source, dry_run: true }) as any;
      expect(transferPreview.binding).toMatchObject({ owner_epoch: large, topology_generation: large });
      const prepared = await call('writer_transfer_prepare', { source_id: f.source, ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') }) as any;
      expect(prepared.owner_epoch).toBe(large);
      const accepted = await call('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: large, manifest: prepared.manifest.digest, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') }) as any;
      expect(accepted.binding.owner_epoch).toBe('9007199254740994');
      expect(accepted.binding.topology_generation).toBe(large);
    } finally { const closed = once(server.server, 'close'); server.close(); await closed; await disposePersistenceConsumer(engine); }
  }), 30_000);
});

test.skipIf(!backends.includes('pglite'))('writer parser accepts explicit self-transfer and cleanup opt-ins', () => {
  expect(parsePersistenceAdminArgs('writer', ['transfer', 'prepare', 'default', '--self-transfer']).params.self_transfer).toBe(true);
  expect(parsePersistenceAdminArgs('writer', ['activate', '--confirm-quiesced', '--cleanup-dead-local-locks']).params.cleanup_dead_local_locks).toBe(true);
});
