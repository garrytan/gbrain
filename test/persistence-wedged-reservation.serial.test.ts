/**
 * Engine-level coverage for the wedged-reservation repair: a refused v0.51 claim leaves a
 * reservation whose coordination lock sits inside the canonical checkout, and every later strict
 * read rejects it — the source is unclaimable and every write fail-closes. These tests exercise
 * the real claim paths, so removing the repair from either of them fails here.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { readPhysicalRootReservation, reservePhysicalRoot } from '../src/core/persistence/physical-root.ts';
import { physicalRootReservationPath, reservationRepairGuardPath } from '../src/core/persistence/physical-root-record.ts';
import { acquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { withEnv } from './helpers/with-env.ts';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-wedged-')));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

async function brainId(): Promise<string> {
  const [row] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  return row.brain_id;
}

/** A source root that is ALSO the brain home — the topology that wedges upstream's claim. */
async function wedgedFixture() {
  const root = join(directory, randomUUID()); mkdirSync(root);
  writeFileSync(join(root, 'page.md'), 'Canonical example');
  const sourceId = `wedged-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const hostId = await withEnv({ GBRAIN_HOME: root }, () => localHostId());
  const worktreeId = randomUUID();
  const info = statSync(root, { bigint: true });
  const record = { version: 1, token: randomUUID(), brainId: await brainId(), worktreeId, hostId, root,
    coordinationPath: join(root, '.gbrain', 'persistence', 'locks', `${worktreeId}.lock`),
    initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString() };
  writeFileSync(physicalRootReservationPath(root), JSON.stringify(record));
  chmodSync(physicalRootReservationPath(root), 0o600);
  return { root, sourceId, hostId, record };
}

test('claimWorktree repairs a wedged reservation and binds the same worktree', async () => {
  const f = await wedgedFixture();
  expect(() => readPhysicalRootReservation(f.root)).toThrow();
  const binding = await withEnv({ GBRAIN_HOME: f.root, GBRAIN_COORDINATION_HOME: join(directory, 'outside-locks') },
    () => claimWorktree(engine, f.sourceId, f.root, f.hostId));
  expect(binding.worktree_id).toBe(f.record.worktreeId);
  const reservation = readPhysicalRootReservation(f.root)!;
  expect(reservation.token).toBe(f.record.token);
  expect(reservation.coordinationPath.startsWith(f.root)).toBe(false);
  expect(binding.coordination_path).toBe(reservation.coordinationPath);
  expect((await getWorktreeBinding(engine, f.sourceId, f.hostId))?.worktree_id).toBe(f.record.worktreeId);
});

test('reservePhysicalRoot repairs on the boundary the managed lifecycle shares', async () => {
  const f = await wedgedFixture();
  const reservation = await withEnv({ GBRAIN_HOME: f.root, GBRAIN_COORDINATION_HOME: join(directory, 'outside-locks') },
    () => reservePhysicalRoot(engine, f.root, { hostId: f.hostId }));
  expect(reservation.worktreeId).toBe(f.record.worktreeId);
  expect(reservation.coordinationPath.startsWith(f.root)).toBe(false);
  expect(JSON.parse(readFileSync(physicalRootReservationPath(f.root), 'utf8')).token).toBe(f.record.token);
});

// The guard must follow the reservation, not the coordination configuration: two repairers with
// different GBRAIN_COORDINATION_HOME values must still serialize on one inode.
test('the repair guard does not depend on the coordination home', async () => {
  const f = await wedgedFixture();
  const a = await withEnv({ GBRAIN_COORDINATION_HOME: join(directory, 'locks-a') }, () => reservationRepairGuardPath(f.root));
  const b = await withEnv({ GBRAIN_COORDINATION_HOME: join(directory, 'locks-b') }, () => reservationRepairGuardPath(f.root));
  expect(a).toBe(b);
  const held = await acquireNativeLock(a, { timeoutMs: 1000 });
  expect(held).not.toBeNull();
  try {
    await withEnv({ GBRAIN_HOME: f.root, GBRAIN_COORDINATION_HOME: join(directory, 'locks-b') }, async () => {
      await expect(claimWorktree(engine, f.sourceId, f.root, f.hostId)).rejects.toThrow();
    });
  } finally { await held!.release(); }
});

// A root with no reservation must not wait on the repair guard — reservePhysicalRoot runs inside a
// database transaction, so blocking there would hold database locks for an unrelated repair.
test('a fresh root claims while the repair guard is held elsewhere', async () => {
  const root = join(directory, randomUUID()); mkdirSync(root);
  const sourceId = `fresh-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const hostId = await withEnv({ GBRAIN_HOME: root }, () => localHostId());
  const held = await acquireNativeLock(reservationRepairGuardPath(root), { timeoutMs: 1000 });
  expect(held).not.toBeNull();
  try {
    const started = Date.now();
    const binding = await withEnv({ GBRAIN_HOME: join(directory, 'fresh-home'), GBRAIN_COORDINATION_HOME: join(directory, 'outside-locks') },
      () => claimWorktree(engine, sourceId, root, hostId));
    expect(binding.local_path).toBe(root);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { await held!.release(); }
});

test('a reservation from another brain or host is not rewritten', async () => {
  for (const field of ['brainId', 'hostId'] as const) {
    const f = await wedgedFixture();
    const record = { ...f.record, [field]: randomUUID() };
    const path = physicalRootReservationPath(f.root);
    writeFileSync(path, JSON.stringify(record));
    const before = readFileSync(path, 'utf8');
    await withEnv({ GBRAIN_HOME: f.root, GBRAIN_COORDINATION_HOME: join(directory, 'outside-locks') }, async () => {
      await expect(claimWorktree(engine, f.sourceId, f.root, f.hostId)).rejects.toThrow();
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
  }
});

test('a committed worktree never changes its lock through first-claim repair', async () => {
  const f = await wedgedFixture();
  await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch) VALUES($1::uuid,$2::uuid,1)', [f.record.worktreeId, f.hostId]);
  const path = physicalRootReservationPath(f.root), before = readFileSync(path, 'utf8');
  await withEnv({ GBRAIN_HOME: f.root, GBRAIN_COORDINATION_HOME: join(directory, 'outside-locks') }, async () => {
    await expect(claimWorktree(engine, f.sourceId, f.root, f.hostId)).rejects.toThrow('verified writer recovery');
  });
  expect(readFileSync(path, 'utf8')).toBe(before);
});
