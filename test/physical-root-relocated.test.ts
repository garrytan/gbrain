/**
 * #5914 (W14 P1.3): a canonical root recreated at the same path (new inode and
 * birth time) refused `recovery_required` from every verb, self-transfer
 * included. `--confirm-relocated-root` on `transfer prepare/accept
 * --self-transfer` waives only the inode/birth comparisons, and only when
 * token, brainId, worktreeId, root and coordination path all agree and the
 * outside-root reservation exists (a copied in-root stamp alone is never
 * authority). The waiver is persisted on the prepared record and required at
 * accept; the re-stamp goes through a compare-and-swap on the reservation.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath, readPhysicalRootReservation, readPhysicalRootStamp,
  replacePhysicalRootReservation } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { recreateRoot } from './helpers/recreate-root.ts';

const backends = testBackends();
for (const kind of backends) describe(`relocated canonical root (${kind})`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-relocated-root-'));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

  async function fixture(run: (f: { root: string; home: string; source: string; binding: NonNullable<Awaited<ReturnType<typeof getWorktreeBinding>>> }) => Promise<void>) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `relocated-${randomUUID().slice(0, 8)}`;
    writeFileSync(join(root, 'note.md'), 'Canonical example');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: source, path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
      await run({ root, home, source, binding: (await getWorktreeBinding(engine, source))! });
    });
  }
  const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
    runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) }) as Promise<any>;
  const storedSelfTransfer = async (worktreeId: string) => (await engine.executeRaw<{ manifest: { self_transfer?: { relocated?: boolean } } }>(
    'SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [worktreeId]))[0].manifest?.self_transfer;

  for (const keepStamp of [true, false]) test(`recreated root (${keepStamp ? 'stamp restored from backup' : 'no stamp'}): refused without the waiver, repaired with it, waiver required at accept`, () => fixture(async f => {
    recreateRoot(f.root, { keepStamp });
    const live = statSync(f.root, { bigint: true });
    await expect(acquireWorktree(f.binding)).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(administer('writer_transfer_prepare', { source_id: f.source, confirm_relocated_root: true })).rejects.toMatchObject({ code: 'invalid_params' });

    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true, confirm_relocated_root: true });
    expect((await storedSelfTransfer(f.binding.worktree_id))?.relocated).toBe(true);
    const accept = { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true };
    await expect(administer('writer_transfer_accept', accept)).rejects.toMatchObject({ code: 'writer_transfer_conflict' });
    expect(readPhysicalRootReservation(f.root)!.initialInode).not.toBe(live.ino.toString());
    await administer('writer_transfer_accept', { ...accept, confirm_relocated_root: true });

    const binding = (await getWorktreeBinding(engine, f.source))!;
    expect(binding.owner_epoch).toBe('2'); expect(binding.state).toBe('active');
    const reservation = readPhysicalRootReservation(f.root)!, stamp = readPhysicalRootStamp(f.root)!;
    expect(reservation.initialInode).toBe(live.ino.toString()); expect(reservation.initialBirth).toBe(live.birthtimeNs.toString());
    expect(stamp.inode).toBe(live.ino.toString()); expect(stamp.token).toBe(reservation.token);
    const lock = await acquireWorktree(binding); expect(lock).not.toBeNull(); await lock?.release();
  }));

  test('the waiver is denied when the reservation is missing or any identity field disagrees; nothing is re-stamped', () => fixture(async f => {
    recreateRoot(f.root, { keepStamp: true });
    const reservationPath = physicalRootReservationPath(f.root), stampPath = join(f.root, PHYSICAL_ROOT_MARKER);
    const reservation = readFileSync(reservationPath, 'utf8'), stamp = readFileSync(stampPath, 'utf8');
    const waived = () => administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true, confirm_relocated_root: true });
    const unchanged = () => { expect(readFileSync(stampPath, 'utf8')).toBe(stamp); expect(existsSync(reservationPath) ? readFileSync(reservationPath, 'utf8') : null).toBeOneOf([reservation, null]); };

    rmSync(reservationPath);
    await expect(waived()).rejects.toMatchObject({ code: 'recovery_required' });
    unchanged();
    writeFileSync(reservationPath, reservation, { mode: 0o600 });

    for (const [field, value] of [['token', randomUUID()], ['worktreeId', randomUUID()], ['brainId', randomUUID()], ['root', join(f.home, 'elsewhere')]] as const) {
      const damaged = { ...JSON.parse(stamp), [field]: value };
      writeFileSync(stampPath, JSON.stringify(damaged), { mode: 0o600 });
      await expect(waived()).rejects.toMatchObject({ code: 'recovery_required' });
      expect(readFileSync(reservationPath, 'utf8')).toBe(reservation);
      writeFileSync(stampPath, stamp, { mode: 0o600 });
    }
    writeFileSync(reservationPath, JSON.stringify({ ...JSON.parse(reservation), coordinationPath: join(f.home, 'other.lock') }), { mode: 0o600 });
    await expect(waived()).rejects.toMatchObject({ code: 'recovery_required' });
    writeFileSync(reservationPath, reservation, { mode: 0o600 });
    unchanged();
    expect(await storedSelfTransfer(f.binding.worktree_id)).toBeUndefined();
  }));

  test('the re-stamp is a compare-and-swap: a second identical swap is a no-op, a stale expectation refuses, and an accept after a foreign re-stamp refuses', () => fixture(async f => {
    recreateRoot(f.root, { keepStamp: true });
    const before = readPhysicalRootReservation(f.root)!;
    const live = statSync(f.root, { bigint: true });
    const next = { ...before, initialDevice: live.dev.toString(), initialInode: live.ino.toString(), initialBirth: live.birthtimeNs.toString() };
    replacePhysicalRootReservation(f.root, before, next);
    expect(readPhysicalRootReservation(f.root)).toEqual(next);
    replacePhysicalRootReservation(f.root, before, next);
    expect(readPhysicalRootReservation(f.root)).toEqual(next);
    expect(() => replacePhysicalRootReservation(f.root, before, { ...next, initialInode: '1' })).toThrow(expect.objectContaining({ code: 'recovery_required', detail: 'stale_record' }));
    expect(readPhysicalRootReservation(f.root)).toEqual(next);

    expect(() => replacePhysicalRootReservation(f.root, next, { ...next, token: randomUUID() })).toThrow(expect.objectContaining({ code: 'recovery_required' }));

    replacePhysicalRootReservation(f.root, next, before);
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true, confirm_relocated_root: true });
    writeFileSync(physicalRootReservationPath(f.root), JSON.stringify({ ...before, initialInode: '1' }), { mode: 0o600 });
    await expect(administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest,
      self_transfer: true, confirm_relocated_root: true })).rejects.toMatchObject({ code: 'recovery_required' });
  }));

  test('the waiver on an intact root is a plain self-transfer: the reservation is left as it is', () => fixture(async f => {
    const reservation = readFileSync(physicalRootReservationPath(f.root), 'utf8');
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true, confirm_relocated_root: true });
    expect((await storedSelfTransfer(f.binding.worktree_id))?.relocated).toBe(true);
    await administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest,
      self_transfer: true, confirm_relocated_root: true });
    expect(readFileSync(physicalRootReservationPath(f.root), 'utf8')).toBe(reservation);
    expect((await getWorktreeBinding(engine, f.source))!.owner_epoch).toBe('2');
  }));
});
