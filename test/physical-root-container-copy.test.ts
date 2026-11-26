/**
 * GBRA-789: a prebuilt brain copied into a container is a new directory at its recorded path on a new filesystem, so
 * its checkout has a new inode AND a new device. The refusal names the relocated-root self-transfer
 * (physical_root_directory_changed) instead of the generic recovery_required, and that self-transfer clears it, since
 * it never compares the device. A malformed device in the stamp is a damaged record and keeps the generic refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath, readPhysicalRootStamp } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { recreateRoot } from './helpers/recreate-root.ts';

for (const kind of testBackends()) describe(`brain copied into a container (${kind})`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-container-copy-'));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

  async function fixture(run: (f: { root: string; source: string; binding: NonNullable<Awaited<ReturnType<typeof getWorktreeBinding>>> }) => Promise<void>) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `container-${randomUUID().slice(0, 8)}`;
    writeFileSync(join(root, 'note.md'), 'Canonical example');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: source, path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
      await run({ root, source, binding: (await getWorktreeBinding(engine, source))! });
    });
  }
  const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
    runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) }) as Promise<any>;
  /** The copy's records name the device of the filesystem it was built on, not the container's. */
  const recordDevice = (root: string, device: string) => {
    const stampPath = join(root, PHYSICAL_ROOT_MARKER), reservationPath = physicalRootReservationPath(root);
    writeFileSync(stampPath, JSON.stringify({ ...JSON.parse(readFileSync(stampPath, 'utf8')), device }), { mode: 0o600 });
    writeFileSync(reservationPath, JSON.stringify({ ...JSON.parse(readFileSync(reservationPath, 'utf8')), initialDevice: device }), { mode: 0o600 });
  };

  test('a new inode and a new device names the relocated-root self-transfer, and that self-transfer clears it', () => fixture(async f => {
    recreateRoot(f.root, { keepStamp: true });
    const live = statSync(f.root, { bigint: true });
    recordDevice(f.root, (live.dev + 1n).toString());
    await expect(acquireWorktree(f.binding)).rejects.toMatchObject({ code: 'recovery_required', detail: 'physical_root_directory_changed',
      suggestion: expect.stringContaining('a new directory on another filesystem device; owner token, brain, worktree and root match') });

    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true, confirm_relocated_root: true });
    await administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest,
      self_transfer: true, confirm_relocated_root: true });
    const binding = (await getWorktreeBinding(engine, f.source))!;
    expect(binding.state).toBe('active');
    expect(readPhysicalRootStamp(f.root)!.device).toBe(live.dev.toString());
    const lock = await acquireWorktree(binding); expect(lock).not.toBeNull(); await lock?.release();
  }));

  test('a malformed device in the stamp keeps the generic refusal', () => fixture(async f => {
    recreateRoot(f.root, { keepStamp: true });
    recordDevice(f.root, 'not-a-device');
    const refusal = await acquireWorktree(f.binding).catch(e => e);
    expect(refusal).toMatchObject({ code: 'recovery_required' });
    expect(refusal.detail).not.toBe('physical_root_directory_changed');
  }));
});
