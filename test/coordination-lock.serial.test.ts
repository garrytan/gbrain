/**
 * #6765/#6766/#6767: the writer coordination lock never lives inside the checkout it coordinates.
 *
 * 1. Protects: a claim, reservation, transfer and writer status resolve the worktree's native lock through
 *    one rule (recorded reservation, then the binding's outside-root path, then persistenceHome()/locks when
 *    it is outside the root, then GBRAIN_COORDINATION_HOME or ~/.gbrain/persistence namespaced by root and
 *    host, else refuse), and a reservation an older release wedged with an inside-root lock is repaired by
 *    the next first claim.
 * 2. Fails when: the claim defaults the lock to persistenceHome() again (GBRAIN_HOME inside the root wedges
 *    the reservation), a transfer recomputes the lock from the accepting process's home, a second process
 *    resolves its own GBRAIN_COORDINATION_HOME instead of the recorded path, the repair rewrites another
 *    brain's/host's/owned reservation, or takes its guard for a healthy root.
 * 3. Existing onboarding and transfer suites keep GBRAIN_HOME outside the checkout, so none reach this path.
 * 4. No seam: real PGLite, real native locks, real reservation files.
 * Serial: withEnv holds GBRAIN_HOME / GBRAIN_COORDINATION_HOME across awaited claims and transfers.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acceptWriterTransfer, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { localHostId, persistenceHome } from '../src/core/persistence/identity.ts';
import { reservePhysicalRoot } from '../src/core/persistence/physical-root.ts';
import { assertPhysicalRoot, physicalRootReservationPath, readPhysicalRootReservation, reservePhysicalRootRecord } from '../src/core/persistence/physical-root-record.ts';
import { acquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { writerOnboardingPreflight } from '../src/core/persistence/onboarding.ts';
import { quarantineCwdDotenv } from '../src/core/env-trust.ts';
import { withEnv } from './helpers/with-env.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-coordination-lock-')));
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(base, { recursive: true, force: true });
});

const outside = (root: string, path: string) => { const rel = relative(root, path); return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`); };
const codeOf = (error: unknown) => (error as { code?: string })?.code;
async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error('expected a refusal');
}
async function source(root: string): Promise<string> {
  const id = `lock-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  return id;
}
async function brainId(): Promise<string> {
  const [row] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  return row.brain_id;
}

test('a checkout that is also GBRAIN_HOME claims with its lock under GBRAIN_COORDINATION_HOME, outside the checkout', async () => {
  const root = join(base, 'home-is-root'), coordination = join(base, 'coordination');
  const sourceId = await source(root);
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: coordination }, async () => {
    const binding = await claimWorktree(engine, sourceId, root);
    const reservation = readPhysicalRootReservation(root)!;
    expect(binding.coordination_path).toBe(reservation.coordinationPath);
    expect(outside(root, binding.coordination_path!)).toBe(true);
    expect(binding.coordination_path!.startsWith(join(coordination, 'locks') + sep)).toBe(true);
    assertPhysicalRoot(root, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
    expect((await claimWorktree(engine, sourceId, root)).worktree_id).toBe(binding.worktree_id);
  });
}, 30_000);

test('a fallback that still resolves inside the checkout refuses before any reservation is written', async () => {
  const root = join(base, 'symlinked-fallback'), alias = join(base, 'alias-into-root');
  const sourceId = await source(root);
  symlinkSync(root, alias, 'dir');
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: alias }, async () => {
    const error = await rejection(claimWorktree(engine, sourceId, root)) as Error & { code?: string; suggestion?: string };
    expect(error.code).toBe('storage_error');
    expect(error.suggestion).toContain('GBRAIN_COORDINATION_HOME');
    expect(existsSync(physicalRootReservationPath(root))).toBe(false);
  });
});

test('two processes with different GBRAIN_COORDINATION_HOME values on one root lock the same recorded file', async () => {
  const root = join(base, 'two-homes');
  const first = await source(root), second = await source(root);
  const homeA = join(base, 'coordination-a'), homeB = join(base, 'coordination-b');
  const claimed = await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: homeA }, () => claimWorktree(engine, first, root));
  expect(claimed.coordination_path!.startsWith(homeA + sep)).toBe(true);
  const held = await acquireNativeLock(claimed.coordination_path!, { timeoutMs: 1000 });
  expect(held).not.toBeNull();
  try {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: homeB }, async () => {
      expect(codeOf(await rejection(claimWorktree(engine, second, root)))).toBe('writer_lock_unavailable');
    });
  } finally { await held!.release(); }
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: homeB }, async () => {
    const reserved = await reservePhysicalRoot(engine, root, { hostId: localHostId() });
    expect(reserved.coordinationPath).toBe(claimed.coordination_path!);
    const joined = await claimWorktree(engine, second, root);
    expect(joined.worktree_id).toBe(claimed.worktree_id);
    expect(joined.coordination_path).toBe(claimed.coordination_path);
  });
  expect(existsSync(join(homeB, 'locks'))).toBe(false);
}, 30_000);

test('GBRAIN_COORDINATION_HOME changed after the reservation: the recorded lock still wins, and writer status and doctor say so with the move step', async () => {
  const { checkCoordinationLockLocation } = await import('../src/commands/doctor/checks/coordination-lock.ts');
  const root = join(base, 'env-changed'), homeA = join(base, 'env-changed-a'), homeB = join(base, 'env-changed-b');
  const sourceId = await source(root);
  const claimed = await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: homeA }, async () => {
    const binding = await claimWorktree(engine, sourceId, root);
    expect((await checkCoordinationLockLocation(engine)).details).toMatchObject({ checkouts: expect.not.arrayContaining([expect.objectContaining({ root })]) });
    return binding;
  });
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: homeB }, async () => {
    expect((await claimWorktree(engine, sourceId, root)).coordination_path).toBe(claimed.coordination_path);
    const status = await writerOnboardingPreflight(engine, sourceId) as { sources: Array<{ coordination_lock?: Record<string, unknown> }> };
    const lock = status.sources[0]!.coordination_lock!;
    expect(lock).toMatchObject({ path: claimed.coordination_path, rule: 'reservation' });
    expect(lock.coordination_home_ignored).toMatchObject({ configured_directory: expect.stringContaining(join(homeB, 'locks')), recorded_path: claimed.coordination_path });
    expect(String((lock.coordination_home_ignored as { move_step: string }).move_step)).toContain('No gbrain command relocates a recorded lock');
    const doctor = await checkCoordinationLockLocation(engine);
    expect(doctor.status).toBe('warn');
    expect(doctor.message).toContain(`records its lock at ${claimed.coordination_path}`);
    expect(doctor.message).toContain('the recorded lock wins');
    expect(doctor.message).toContain(`Make ${dirname(claimed.coordination_path!)} survive container recreation`);
  });
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: homeA }, async () => {
    const status = await writerOnboardingPreflight(engine, sourceId) as { sources: Array<{ coordination_lock?: Record<string, unknown> }> };
    expect(status.sources[0]!.coordination_lock!.coordination_home_ignored).toBeUndefined();
  });
}, 30_000);

test('an ordinary root keeps its lock under persistenceHome() and never reads GBRAIN_COORDINATION_HOME', async () => {
  const home = join(base, 'ordinary-home'), root = join(base, 'ordinary-root');
  const sourceId = await source(root);
  await withEnv({ GBRAIN_HOME: home, GBRAIN_COORDINATION_HOME: 'relative/not-used' }, async () => {
    const binding = await claimWorktree(engine, sourceId, root);
    expect(binding.coordination_path).toBe(join(persistenceHome(), 'locks', `${binding.worktree_id}.lock`));
  });
});

test('the resolver namespaces the fallback by canonical root and host, defaults to ~/.gbrain/persistence and validates the override', async () => {
  const { resolveCoordinationLock } = await import('../src/core/persistence/coordination-lock.ts');
  const root = join(base, 'resolver-root'), nested = join(root, 'nested');
  mkdirSync(nested, { recursive: true });
  const hostA = randomUUID(), hostB = randomUUID();
  await withEnv({ GBRAIN_HOME: nested, GBRAIN_COORDINATION_HOME: join(base, 'shared') }, () => {
    const first = resolveCoordinationLock(root, 'worktree', {}, hostA);
    expect(first.rule).toBe('coordination_home');
    expect(resolveCoordinationLock(root, 'worktree', {}, hostA).path).toBe(first.path);
    expect(resolveCoordinationLock(root, 'worktree', {}, hostB).path).not.toBe(first.path);
    expect(resolveCoordinationLock(nested, 'worktree', {}, hostA).path).not.toBe(first.path);
    expect(resolveCoordinationLock(root, 'worktree', { reservation: '/recorded/reservation.lock', binding: '/recorded/binding.lock' }, hostA))
      .toEqual({ path: '/recorded/reservation.lock', rule: 'reservation' });
    expect(resolveCoordinationLock(root, 'worktree', { binding: '/recorded/binding.lock' }, hostA)).toEqual({ path: '/recorded/binding.lock', rule: 'binding' });
    expect(resolveCoordinationLock(root, 'worktree', { binding: join(root, 'inside.lock') }, hostA).rule).toBe('coordination_home');
  });
  await withEnv({ GBRAIN_HOME: nested, GBRAIN_COORDINATION_HOME: undefined }, () => {
    const fallback = resolveCoordinationLock(root, 'worktree', {}, hostA);
    expect(fallback.rule).toBe('home_default');
    expect(fallback.path.startsWith(join(realpathSync(homedir()), '.gbrain', 'persistence', 'locks') + sep)).toBe(true);
  });
  for (const value of ['relative', `${join(base, 'shared')}/../elsewhere`]) {
    await withEnv({ GBRAIN_HOME: nested, GBRAIN_COORDINATION_HOME: value }, () => {
      expect(() => resolveCoordinationLock(root, 'worktree', {}, hostA)).toThrow('GBRAIN_COORDINATION_HOME');
    });
  }
});

for (const reserved of [false, true]) {
  test(reserved ? 'a transfer takes the successor reservation\'s lock first' : 'a transfer accepted under another GBRAIN_HOME keeps the recorded lock', async () => {
    const home = join(base, randomUUID()), root = join(home, 'checkout'), successor = join(home, 'successor');
    const sourceId = await source(root);
    writeFileSync(join(root, 'page.md'), 'Example content');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const host = localHostId();
      const original = await claimWorktree(engine, sourceId, root, host);
      cpSync(root, successor, { recursive: true });
      let expected = original.coordination_path!;
      if (reserved) {
        expected = join(home, 'successor.lock');
        reservePhysicalRootRecord(successor, { brainId: await brainId(), worktreeId: original.worktree_id, hostId: host, coordinationPath: expected });
      }
      const prepared = await prepareWriterTransfer(engine, sourceId, host);
      await withEnv({ GBRAIN_HOME: join(home, 'new-home') }, () =>
        acceptWriterTransfer(engine, sourceId, successor, prepared.owner_epoch, prepared.manifest.digest, host));
      const transferred = await getWorktreeBinding(engine, sourceId, host);
      expect(transferred?.local_path).toBe(successor);
      expect(transferred?.coordination_path).toBe(expected);
      expect(readPhysicalRootReservation(successor)?.coordinationPath).toBe(expected);
    });
  }, 30_000);
}

/** The record a release before this fix left behind: valid in every field, its lock inside the checkout. */
async function wedged(overrides: Record<string, string> = {}) {
  const root = join(base, `wedged-${randomUUID()}`);
  const sourceId = await source(root);
  writeFileSync(join(root, 'page.md'), 'Canonical example');
  const hostId = await withEnv({ GBRAIN_HOME: root }, () => localHostId());
  const worktreeId = randomUUID(), info = statSync(root, { bigint: true });
  const record = { version: 1, token: randomUUID(), brainId: await brainId(), worktreeId, hostId, root,
    coordinationPath: join(root, '.gbrain', 'persistence', 'locks', `${worktreeId}.lock`),
    initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString(), ...overrides };
  const path = physicalRootReservationPath(root);
  writeFileSync(path, JSON.stringify(record));
  chmodSync(path, 0o600);
  return { root, sourceId, hostId, record, path, env: { GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: join(base, 'repaired-locks') } };
}

test('a first claim repairs a reservation wedged by the old inside-root lock and keeps its identity', async () => {
  const f = await wedged();
  expect(() => readPhysicalRootReservation(f.root)).toThrow();
  const binding = await withEnv(f.env, () => claimWorktree(engine, f.sourceId, f.root, f.hostId));
  const reservation = readPhysicalRootReservation(f.root)!;
  expect(binding.worktree_id).toBe(f.record.worktreeId);
  expect({ ...reservation, coordinationPath: f.record.coordinationPath }).toEqual(f.record as typeof reservation);
  expect(outside(f.root, reservation.coordinationPath)).toBe(true);
  expect(binding.coordination_path).toBe(reservation.coordinationPath);
}, 30_000);

test('the managed reservation boundary repairs the same wedge', async () => {
  const f = await wedged();
  const reservation = await withEnv(f.env, () => reservePhysicalRoot(engine, f.root, { hostId: f.hostId }));
  expect(reservation.worktreeId).toBe(f.record.worktreeId);
  expect(reservation.token).toBe(f.record.token);
  expect(outside(f.root, reservation.coordinationPath)).toBe(true);
});

test('a wedged reservation of another brain or host, or of a recorded worktree, is never rewritten', async () => {
  for (const overrides of [{ brainId: randomUUID() }, { hostId: randomUUID() }] as Record<string, string>[]) {
    const f = await wedged(overrides);
    const before = readFileSync(f.path, 'utf8');
    await withEnv(f.env, async () => { await rejection(claimWorktree(engine, f.sourceId, f.root, f.hostId)); });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
  }
  const f = await wedged();
  await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch) VALUES($1::uuid,$2::uuid,1)', [f.record.worktreeId, f.hostId]);
  const before = readFileSync(f.path, 'utf8');
  await withEnv(f.env, async () => {
    expect((await rejection(claimWorktree(engine, f.sourceId, f.root, f.hostId))).message).toContain('verified writer recovery');
  });
  expect(readFileSync(f.path, 'utf8')).toBe(before);
}, 30_000);

test('repairers serialize on a guard derived from the root, while a healthy root never takes it', async () => {
  const f = await wedged();
  const guard = await acquireNativeLock(`${physicalRootReservationPath(f.root)}.repair.lock`, { timeoutMs: 1000 });
  expect(guard).not.toBeNull();
  const fresh = join(base, `fresh-${randomUUID()}`);
  const freshSource = await source(fresh);
  const freshGuard = await acquireNativeLock(`${physicalRootReservationPath(fresh)}.repair.lock`, { timeoutMs: 1000 });
  expect(freshGuard).not.toBeNull();
  try {
    await withEnv({ ...f.env, GBRAIN_COORDINATION_HOME: join(base, 'other-locks') }, async () => {
      expect(codeOf(await rejection(claimWorktree(engine, f.sourceId, f.root, f.hostId)))).toBe('writer_lock_unavailable');
    });
    await withEnv({ GBRAIN_HOME: join(base, 'fresh-home') }, async () => {
      expect((await claimWorktree(engine, freshSource, fresh)).local_path).toBe(fresh);
    });
  } finally { await guard!.release(); await freshGuard!.release(); }
}, 30_000);

test('a cwd .env cannot redirect the coordination lock', () => {
  const dir = join(base, 'cwd-dotenv');
  mkdirSync(dir);
  writeFileSync(join(dir, '.env'), `GBRAIN_COORDINATION_HOME=${join(dir, 'planted')}\n`);
  const env: Record<string, string | undefined> = { GBRAIN_COORDINATION_HOME: join(dir, 'planted') };
  expect(quarantineCwdDotenv(env, dir, { warn: () => {} })).toEqual(['GBRAIN_COORDINATION_HOME']);
  expect(env.GBRAIN_COORDINATION_HOME).toBeUndefined();
});

test('writer status prints the resolved lock path and the rule that chose it', async () => {
  const root = join(base, 'status-root'), coordination = join(base, 'status-locks');
  const bound = await source(root);
  const pending = await source(join(base, 'status-unclaimed'));
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: coordination }, async () => {
    const binding = await claimWorktree(engine, bound, root);
    const [claimed] = (await writerOnboardingPreflight(engine, bound)).sources as Array<Record<string, any>>;
    expect(claimed.coordination_lock).toEqual({ path: binding.coordination_path, rule: 'reservation' });
    const [unclaimed] = (await writerOnboardingPreflight(engine, pending)).sources as Array<Record<string, any>>;
    expect(unclaimed.coordination_lock).toMatchObject({ path: null, rule: 'persistence_home', directory: join(persistenceHome(), 'locks') });
  });
  const f = await wedged();
  await withEnv(f.env, async () => {
    const [stuck] = (await writerOnboardingPreflight(engine, f.sourceId)).sources as Array<Record<string, any>>;
    expect(stuck.coordination_lock).toMatchObject({ path: f.record.coordinationPath, rule: 'reservation', old_path_wedge: true });
  });
}, 30_000);
