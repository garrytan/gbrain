/**
 * Claims must succeed when the configuration home is the canonical checkout.
 * Previously the new lock was placed inside that root and the reservation
 * rejected it. Other onboarding tests keep the home outside the checkout.
 * Exercises the production claim with real filesystem locks and PGLite; no seam.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { assertPhysicalRoot, readPhysicalRootReservation } from '../src/core/persistence/physical-root-record.ts';
import { withEnv } from './helpers/with-env.ts';
import { coordinationLockPath } from '../src/core/persistence/coordination-lock.ts';
import { persistenceHome } from '../src/core/persistence/identity.ts';

let engine: PGLiteEngine;
const base = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-lock-placement-')));
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); rmSync(base, { recursive: true, force: true }); });

test('claims a root that contains its configuration home with an outside lock', async () => {
  const root = join(base, 'canonical'), fallback = join(base, 'coordination');
  mkdirSync(root); mkdirSync(fallback);
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: fallback }, async () => {
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
    const binding = await claimWorktree(engine, 'default', root);
    const reservation = readPhysicalRootReservation(root)!;
    expect(binding.coordination_path).toBe(reservation.coordinationPath);
    const path = relative(root, reservation.coordinationPath);
    expect(isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)).toBe(true);
    expect(reservation.coordinationPath.startsWith(fallback + sep)).toBe(true);
    assertPhysicalRoot(root, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
    expect((await claimWorktree(engine, 'default', root)).worktree_id).toBe(binding.worktree_id);
  });
}, 30_000);

test('refuses a fallback symlink into the checkout before reserving it', async () => {
  const root = join(base, 'other'), alias = join(base, 'inside-alias');
  mkdirSync(root); symlinkSync(root, alias, 'dir');
  await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: alias }, async () => {
    await expect(claimWorktree(engine, 'default', root)).rejects.toThrow();
    expect(readPhysicalRootReservation(root)).toBeNull();
  });
});

test('keeps ordinary paths stable and only validates a fallback when it is needed', () =>
  withEnv({ GBRAIN_HOME: join(base, 'separate-home'), GBRAIN_COORDINATION_HOME: 'relative' }, () => {
    const root = join(base, 'ordinary-root');
    expect(coordinationLockPath(root, 'worktree')).toBe(join(persistenceHome(), 'locks', 'worktree.lock'));
  }));

test('namespaces shared fallback by canonical checkout and registered host', async () => {
  const root = join(base, 'namespace-root'), other = join(root, 'other');
  mkdirSync(other, { recursive: true });
  await withEnv({ GBRAIN_HOME: other, GBRAIN_COORDINATION_HOME: join(base, 'shared') }, () => {
    const first = coordinationLockPath(root, 'same-worktree');
    expect(coordinationLockPath(root, 'same-worktree')).toBe(first);
    expect(coordinationLockPath(other, 'same-worktree')).not.toBe(first);
    writeFileSync(join(persistenceHome(), 'host.json'), JSON.stringify({ version: 1, id: '22222222-2222-4222-8222-222222222222' }));
    expect(coordinationLockPath(root, 'same-worktree')).not.toBe(first);
  });
});

test('rejects relative and traversing fallback paths', async () => {
  const root = join(base, 'invalid-override');
  mkdirSync(root);
  for (const override of ['relative', join(base, 'shared') + '/../elsewhere']) {
    await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: override }, () => {
      expect(() => coordinationLockPath(root, 'worktree')).toThrow('absolute path without');
    });
  }
});
