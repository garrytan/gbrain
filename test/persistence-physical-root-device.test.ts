import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { assertPhysicalRoot } from '../src/core/persistence/physical-root.ts';
import * as rootRecord from '../src/core/persistence/physical-root-record.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

// #5604: macOS can assign a checkout's filesystem a new st_dev across reboots.
// The persisted physical-root identity kept the old device, so every managed
// write refused with recovery_required until a manual self-transfer.

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

test('device-only change is recognized only with a non-zero matching birth time and inode', () => {
  const stamp = { version: 1 as const, token: randomUUID(), brainId: randomUUID(), worktreeId: randomUUID(), root: '/example/root', device: '7', inode: '11', birth: '13' };
  const reservation = { token: stamp.token, brainId: stamp.brainId, worktreeId: stamp.worktreeId, root: stamp.root };
  const info = (dev: bigint, ino: bigint, birth: bigint) => ({ dev, ino, birthtimeNs: birth });
  const physicalRootDeviceChange = (rootRecord as Record<string, any>).physicalRootDeviceChange;
  expect(physicalRootDeviceChange(stamp, reservation, info(8n, 11n, 13n))).toEqual({ from: '7', to: '8' });
  expect(physicalRootDeviceChange(stamp, reservation, info(7n, 11n, 13n))).toBeNull();
  expect(physicalRootDeviceChange({ ...stamp, birth: '0' }, reservation, info(8n, 11n, 0n))).toBeNull();
  expect(physicalRootDeviceChange(stamp, reservation, info(8n, 12n, 13n))).toBeNull();
  expect(physicalRootDeviceChange(stamp, reservation, info(8n, 11n, 14n))).toBeNull();
  expect(physicalRootDeviceChange(stamp, { ...reservation, token: randomUUID() }, info(8n, 11n, 13n))).toBeNull();
  expect(physicalRootDeviceChange({ ...stamp, root: '/other' }, reservation, info(8n, 11n, 13n))).toBeNull();
});

for (const kind of testBackends()) describe(`physical root device change (${kind})`, () => {
  // The canonical root is the real path: on macOS the temporary directory sits behind the /var -> /private/var symlink.
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-root-device-')));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    if (close) await close(); else await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  async function fixture(run: (f: { root: string; source: string; live: string; ctx: OperationContext;
    registration: Awaited<ReturnType<typeof registerLocalWriter>> }) => Promise<void>) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `device-${randomUUID().slice(0, 8)}`;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await claimWorktree(engine, source, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const registration = await registerLocalWriter(engine, 'cli');
      const ctx: OperationContext = { engine, remote: false, sourceId: source, config: { engine: engine.kind, embedding_disabled: true } as never,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await run({ root, source, live: statSync(root, { bigint: true }).dev.toString(), ctx, registration });
    });
  }
  /** Simulate the reboot: every persisted copy still names the previous device. */
  async function reboot(root: string, source: string, previous: string) {
    const marker = join(root, PHYSICAL_ROOT_MARKER), reservation = physicalRootReservationPath(root);
    writeJson(marker, { ...readJson(marker), device: previous });
    writeJson(reservation, { ...readJson(reservation), initialDevice: previous });
    const binding = (await getWorktreeBinding(engine, source))!;
    const selfTransfer = { hostId: randomUUID(), before: { reservation: { ...readJson(reservation) }, stamp: { ...readJson(marker) } },
      reservation: { ...readJson(reservation) }, stamp: { ...readJson(marker) } };
    await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid',
      [binding.worktree_id, JSON.stringify({ digest: 'previous-transfer', files: {}, self_transfer: selfTransfer })]);
    const stage = `${root}.stage-${randomUUID().slice(0, 8)}`; mkdirSync(stage);
    const info = statSync(stage, { bigint: true });
    await engine.executeRaw(`INSERT INTO persistence_topology_changes(principal_id,request_id,digest,operation,source_id,worktree_ids,state,recovery)
      VALUES($1::uuid,$2::uuid,'example','reclone',$3,ARRAY[$4::uuid],'recovering',$5::text::jsonb)`, [randomUUID(), randomUUID(), source, binding.worktree_id,
      JSON.stringify({ stage, stageIdentity: { device: previous, inode: info.ino.toString(), birthNs: info.birthtimeNs.toString() } })]);
    return binding;
  }
  const put = (f: Parameters<Parameters<typeof fixture>[0]>[0], slug: string) => withVerifiedLocalRegistration(engine, f.registration, () =>
    operationsByName.put_page!.handler(f.ctx, { source_id: f.source, slug, request_id: randomUUID(),
      content: '---\ntype: note\ntitle: Example\n---\nA managed observation after a reboot.\n' })) as Promise<Record<string, unknown>>;

  test('a device-only change re-stamps every persisted copy under the native lock and managed writes succeed', () => fixture(async f => {
    const previous = String(BigInt(f.live) + 1n);
    const binding = await reboot(f.root, f.source, previous);
    expect(await put(f, 'notes/after-reboot').then(r => r.state, (e: { code?: string }) => e.code)).toBe('committed');
    expect(readJson(join(f.root, PHYSICAL_ROOT_MARKER)).device).toBe(f.live);
    expect(readJson(physicalRootReservationPath(f.root)).initialDevice).toBe(f.live);
    const [owner] = await engine.executeRaw<{ manifest: { self_transfer: Record<string, any> } }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [binding.worktree_id]);
    const recorded = owner.manifest.self_transfer;
    expect([recorded.before.reservation.initialDevice, recorded.before.stamp.device, recorded.reservation.initialDevice, recorded.stamp.device]).toEqual([f.live, f.live, f.live, f.live]);
    const [topology] = await engine.executeRaw<{ recovery: { stageIdentity: { device: string } } }>(
      "SELECT recovery FROM persistence_topology_changes WHERE state='recovering' AND $1::uuid=ANY(worktree_ids)", [binding.worktree_id]);
    expect(topology.recovery.stageIdentity.device).toBe(f.live);
    await engine.executeRaw("UPDATE persistence_topology_changes SET state='failed' WHERE $1::uuid=ANY(worktree_ids)", [binding.worktree_id]);
    assertPhysicalRoot(f.root, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
    expect((await put(f, 'notes/second-write')).state).toBe('committed');
  }), 60_000);

  test('a re-stamp interrupted after its database commit finishes on the next locked write', () => fixture(async f => {
    const binding = await reboot(f.root, f.source, String(BigInt(f.live) + 1n));
    const [owner] = await engine.executeRaw<{ manifest: { self_transfer: Record<string, any> } }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [binding.worktree_id]);
    const recorded = owner.manifest.self_transfer;
    recorded.before.reservation.initialDevice = recorded.before.stamp.device = recorded.reservation.initialDevice = recorded.stamp.device = f.live;
    await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [binding.worktree_id, JSON.stringify(owner.manifest)]);
    await engine.executeRaw("UPDATE persistence_topology_changes SET state='failed' WHERE $1::uuid=ANY(worktree_ids)", [binding.worktree_id]);
    expect((await put(f, 'notes/after-interrupted-restamp')).state).toBe('committed');
    expect(readJson(join(f.root, PHYSICAL_ROOT_MARKER)).device).toBe(f.live);
    expect(readJson(physicalRootReservationPath(f.root)).initialDevice).toBe(f.live);
  }), 60_000);

  test('a device change with a different inode or birth time still refuses and rewrites nothing', () => fixture(async f => {
    const previous = String(BigInt(f.live) + 1n);
    const binding = await reboot(f.root, f.source, previous);
    const marker = join(f.root, PHYSICAL_ROOT_MARKER);
    for (const change of [{ inode: String(BigInt(readJson(marker).inode) + 1n) }, { birth: '0' }]) {
      const original = readJson(marker);
      writeJson(marker, { ...original, ...change });
      await expect(acquireWorktree(binding, 0, undefined, engine)).rejects.toMatchObject({ code: 'recovery_required' });
      expect(readJson(marker)).toEqual({ ...original, ...change });
      expect(readJson(physicalRootReservationPath(f.root)).initialDevice).toBe(previous);
      writeJson(marker, original);
    }
  }), 60_000);

  test('the device refusal names the filled self-transfer commands and they restore writes', () => fixture(async f => {
    const binding = await reboot(f.root, f.source, String(BigInt(f.live) + 1n));
    const refusal = await acquireWorktree(binding).then(() => null, (error: unknown) => error as { code: string; detail?: string; suggestion?: string });
    expect(refusal).toMatchObject({ code: 'recovery_required', detail: 'physical_root_device_changed' });
    expect(refusal!.suggestion).toContain(`gbrain sources writer transfer prepare ${f.source} --self-transfer`);
    expect(refusal!.suggestion).toContain(`gbrain sources writer transfer accept ${f.source} --path ${f.root} --expected-epoch ${binding.owner_epoch}`);
    expect(() => assertPhysicalRoot(f.root, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path }))
      .toThrow(expect.objectContaining({ code: 'recovery_required', detail: 'physical_root_device_changed' }));
    expect(readJson(join(f.root, PHYSICAL_ROOT_MARKER)).device).toBe(String(BigInt(f.live) + 1n));
    const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
      runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    expect(prepared.owner_epoch).toBe(String(binding.owner_epoch));
    await administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    const lock = await acquireWorktree((await getWorktreeBinding(engine, f.source))!); expect(lock).not.toBeNull(); await lock?.release();
  }), 60_000);
});
