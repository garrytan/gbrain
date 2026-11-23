/**
 * Engine parity for the wedged reservation repair (persistence/coordination-lock.ts `repairWedgedReservation`, #6766):
 * a release before #6765 recorded the coordination lock of a checkout inside that checkout, so every later claim
 * failed closed. A first claim on the reserving host moves only that lock path out of the checkout and keeps the
 * reservation's identity, when the brain and host match and no worktree row exists for it.
 *
 * The repair reads this brain's id and the worktree row through the claim store, so every engine answers it. The
 * claim is the internal `claimWorktree` (the automatic claim of a first write), not the `writer claim` verb. Each case
 * runs under its own GBRAIN_HOME.
 */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { physicalRootReservationPath, readPhysicalRootReservation } from '../../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** The record a release before #6765 left behind: valid in every field, its lock inside the checkout. */
async function wedge(engine: BrainEngine, root: string, hostId: string, overrides: Record<string, string> = {}) {
  const worktreeId = randomUUID(), info = statSync(root, { bigint: true });
  const record = { version: 1, token: randomUUID(), brainId: await engine.readPersistenceBrainId(), worktreeId, hostId, root,
    coordinationPath: join(root, '.gbrain', 'persistence', 'locks', `${worktreeId}.lock`),
    initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString(), ...overrides };
  const path = physicalRootReservationPath(root);
  writeFileSync(path, JSON.stringify(record));
  chmodSync(path, 0o600);
  return { record, path };
}

async function inHome<T>(prefix: string, body: (home: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_COORDINATION_HOME: join(home, 'repaired-locks'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      () => body(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('wedged reservation repair', () => {
  parityTest('a first claim moves a wedged coordination lock out of the checkout and keeps its identity', {
    methods: ['worktreeClaimStore', 'readPersistenceBrainId'],
  }, async (engine, backend) => inHome('gbrain-wedged-parity-', async home => {
    const root = join(home, 'checkout');
    await Bun.write(join(root, 'example.md'), 'generic example');
    await createSource(engine, backend, 'work', {}, root);
    try {
      const hostId = await localHostId();
      const { record } = await wedge(engine, root, hostId);
      expect(record.brainId).not.toBeNull();
      expect(() => readPhysicalRootReservation(root)).toThrow();
      const binding = await claimWorktree(engine, 'work', root, hostId);
      const reservation = readPhysicalRootReservation(root)!;
      const answers = {
        same_worktree: binding.worktree_id === record.worktreeId,
        same_identity: JSON.stringify({ ...reservation, coordinationPath: record.coordinationPath }) === JSON.stringify(record),
        lock_outside_checkout: outside(root, reservation.coordinationPath),
        binding_uses_lock: binding.coordination_path === reservation.coordinationPath,
      };
      expect(answers).toEqual({ same_worktree: true, same_identity: true, lock_outside_checkout: true, binding_uses_lock: true });
      return answers;
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }));

  parityTest('a wedged reservation of another brain is never rewritten', {
    methods: ['worktreeClaimStore', 'readPersistenceBrainId'],
  }, async (engine, backend) => inHome('gbrain-wedged-foreign-parity-', async home => {
    const root = join(home, 'checkout');
    await Bun.write(join(root, 'example.md'), 'generic example');
    await createSource(engine, backend, 'work', {}, root);
    try {
      const { path } = await wedge(engine, root, await localHostId(), { brainId: randomUUID() });
      const before = readFileSync(path, 'utf8');
      const refusal = await claimWorktree(engine, 'work', root).then(() => null, (error: Error & { code?: string }) => error);
      const answers = { refused: refusal !== null, message: refusal?.message ?? null, unchanged: readFileSync(path, 'utf8') === before };
      expect(answers.refused).toBe(true);
      expect(answers.message).toContain('another brain');
      expect(answers.unchanged).toBe(true);
      return answers;
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }));
});
