/**
 * #5914 (W14 P1.3c [R9b]): the recorded canonical path now traverses a
 * symlink (the checkout was moved and a link left at the old path). Every
 * verb refused `recovery_required` before any inode comparison, with no exit.
 * `gbrain sources set-path <id> <old-or-new-path>` now converges when
 * `realpathSync(old) === new` and the reservation and stamp agree on token,
 * brainId and worktreeId: the host binding and `local_path` move to the real
 * directory, the reservation is rewritten under the new `sha256(root)` name,
 * the old one is removed and the stamp names the new root. The worktree keeps
 * its id; nothing else about the identity check is relaxed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath, readPhysicalRootReservation, readPhysicalRootStamp } from '../src/core/persistence/physical-root-record.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
for (const kind of backends) describe(`canonical path through a symlink (${kind})`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-symlink-root-'));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

  async function fixture(run: (f: { root: string; real: string; home: string; source: string; binding: NonNullable<Awaited<ReturnType<typeof getWorktreeBinding>>> }) => Promise<void>) {
    const home = mkdtempSync(join(directory, 'home-')), root = join(home, 'root'), real = join(home, 'moved', 'root'); mkdirSync(root, { recursive: true });
    const source = `symlink-${randomUUID().slice(0, 8)}`;
    writeFileSync(join(root, 'note.md'), 'Canonical example');
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await resetPgliteState(engine as PGLiteEngine);
      await registerLocalWriter(engine, 'cli');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await claimWorktree(engine, source, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const binding = (await getWorktreeBinding(engine, source))!;
      mkdirSync(join(home, 'moved'));
      renameSync(root, real);
      symlinkSync(real, root);
      await run({ root, real, home, source, binding });
    });
  }
  const setPath = (source: string, path: string) => runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: source, path });

  test('set-path to the recorded (now symlinked) path or its real target converges and keeps the worktree', () => fixture(async f => {
    await expect(acquireWorktree(f.binding)).rejects.toMatchObject({ code: 'recovery_required' });
    const oldReservation = physicalRootReservationPath(f.root);
    expect(existsSync(oldReservation)).toBe(true);
    const token = JSON.parse(readFileSync(join(f.real, PHYSICAL_ROOT_MARKER), 'utf8')).token;

    const receipt = await setPath(f.source, f.root) as Record<string, any>;
    expect(receipt.noop).not.toBe(true);
    const binding = (await getWorktreeBinding(engine, f.source))!;
    expect(binding.worktree_id).toBe(f.binding.worktree_id);
    expect(binding.local_path).toBe(f.real);
    expect((await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [f.source]))[0].local_path).toBe(f.real);
    expect(existsSync(oldReservation)).toBe(false);
    const reservation = readPhysicalRootReservation(f.real)!, stamp = readPhysicalRootStamp(f.real)!;
    expect(reservation.root).toBe(f.real); expect(reservation.token).toBe(token);
    expect(stamp.root).toBe(f.real); expect(stamp.token).toBe(token);
    const lock = await acquireWorktree(binding); expect(lock).not.toBeNull(); await lock?.release();

    const again = await setPath(f.source, f.real) as Record<string, any>;
    expect(again.noop).toBe(true);
  }));

  test('a token or worktree mismatch keeps the refusal; no reservation moves', () => fixture(async f => {
    const stampPath = join(f.real, PHYSICAL_ROOT_MARKER), stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    writeFileSync(stampPath, JSON.stringify({ ...stamp, token: randomUUID() }), { mode: 0o600 });
    await expect(setPath(f.source, f.root)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(existsSync(physicalRootReservationPath(f.root))).toBe(true);
    expect(existsSync(physicalRootReservationPath(f.real))).toBe(false);
    expect((await getWorktreeBinding(engine, f.source))!.local_path).toBe(f.root);
  }));
});
