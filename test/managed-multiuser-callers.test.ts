/**
 * Every worktree-lock caller of managed mode, against a competing managed lease, on a real multi-user Rust brain (lane LM
 * slice 3, gate D1; finding F4 of /code/.plans/lm/autoplan-s3/eng-native.a1.md).
 *
 * A second host (here: another holder of the lease `managed:worktree:<id>` or `managed:topology:<brain>`) owns the
 * checkout's lease. Each caller must refuse with the busy answer it always gave, before it changes anything, and the same call
 * must go through once the lease is free. Callers covered: activation, deactivation, the pre-activation release, source
 * lifecycle (topology locks, both leases), and the writer transfer forms (prepare, self-transfer prepare, cancel, accept).
 * Shared-skill activation takes the Rust store's own activation on a Rust brain and never reaches a worktree lock (pinned).
 *
 * The caller that takes the lease must be the process's own registration, and none of these steps seeds
 * `setHostRegistration`: the process registers itself (managed-registration.ts).
 *
 * Needs the Rust addon: runs with GBRAIN_TEST_RUST_ARM=1 (as the Rust CI job does), and is skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openRustBrain, removeBrainDir, rustArmRequested, createRustSource, type RustBrainDir } from './engine-parity/rust-arm.ts';
import { liftManagedHold } from './engine-parity/rust-managed.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { readManagedMode } from '../src/core/persistence/managed-mode.ts';
import { hostIdFor } from '../src/core/persistence/identity.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { rustLeases, type LeaseToken, type WriteOrigin } from '../src/core/rust-engine/store-members/leases.ts';

const other: WriteOrigin = { host_id: 'bbbbbbbb-2222-4333-8444-555555555555', incarnation: 'other', writer_id: 'local_cli:other' };
const code = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string }) => e?.code ?? String(e));

describe.skipIf(!rustArmRequested())('managed mode on a multi-user Rust brain: every worktree-lock caller meets a competing managed lease', () => {
  let brain: RustBrainDir;
  let engine: BrainEngine;
  let home: string;
  let root: string;
  let worktreeId: string;
  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-mu-callers-')));
    // GBRAIN_RUST_MULTIUSER is read when the arm opens the store; the checkout and the identity live under the scratch home.
    await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_MULTIUSER: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      brain = await openRustBrain('env');
      liftManagedHold(brain.engine);
      engine = brain.engine as unknown as BrainEngine;
    });
  }, 60_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.disconnect();
    });
    removeBrainDir(brain.dir);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  const env = <T>(run: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_MULTIUSER: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, run);
  const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
  const leases = () => rustLeases(engine as never);
  const take = async (name: string): Promise<LeaseToken> => (await leases().acquire(name, other, 600_000))!;
  const freeLease = async (token: LeaseToken) => { await leases().release(token); };

  test('activation and the pre-activation release refuse writer_not_quiesced / writer_lock_unavailable under a competing worktree lease, and go through once it is free', () => env(async () => {
    root = join(home, 'checkout');
    mkdirSync(join(root, 'notes'), { recursive: true });
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
    writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
    await createRustSource(engine, 'work', {}, root);
    await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
    worktreeId = (await engine.getWorktreeBinding('work', hostIdFor(engine)))!.worktree_id;
    const rival = await take(`managed:worktree:${worktreeId}`);
    expect(await readManagedMode(engine)).toBe(false);
    // The pre-activation release (deactivate on a claimed, never-activated brain) refuses before it retires anything.
    expect(await code(async () => runPersistenceAdministration(engine, 'writer_deactivate', { ...await reviewed('writer_deactivate') }))).toBe('writer_lock_unavailable');
    expect(await code(async () => runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') }))).toBe('writer_not_quiesced');
    expect(await readManagedMode(engine)).toBe(false);
    expect(await engine.getWorktreeBinding('work', hostIdFor(engine))).not.toBeNull();
    await freeLease(rival);
    await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
    expect(await readManagedMode(engine)).toBe(true);
  }), 120_000);

  test('deactivation refuses writer_lock_unavailable under a competing worktree lease; managed mode stays on', () => env(async () => {
    const rival = await take(`managed:worktree:${worktreeId}`);
    expect(await code(async () => runPersistenceAdministration(engine, 'writer_deactivate', { ...await reviewed('writer_deactivate') }))).toBe('writer_lock_unavailable');
    expect(await readManagedMode(engine)).toBe(true);
    await freeLease(rival);
  }), 120_000);

  test('source lifecycle refuses write_pending under a competing topology lease and under a competing worktree lease; nothing changes', () => env(async () => {
    const brainId = (await engine.readPersistenceBrainId())!;
    const before = { source: await engine.readSourceMembership('work'), files: readdirSync(join(root, 'notes')).sort() };
    for (const name of [`managed:topology:${brainId}`, `managed:worktree:${worktreeId}`]) {
      const rival = await take(name);
      expect(await code(() => runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'work' }))).toBe('write_pending');
      await freeLease(rival);
    }
    expect({ source: await engine.readSourceMembership('work'), files: readdirSync(join(root, 'notes')).sort() }).toEqual(before);
    // With both leases free, the same lifecycle change goes through (archive, then restore).
    const archived = await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'work' });
    expect(archived).toBeTruthy();
    expect((await engine.readSourceMembership('work'))?.archived).toBe(true);
    await runManagedSourceLifecycle(engine, { operation: 'restore', sourceId: 'work' });
    expect((await engine.readSourceMembership('work'))?.archived).toBe(false);
  }), 180_000);

  test('the writer transfer forms (prepare, self-transfer prepare, cancel, accept) each refuse write_pending under a competing worktree lease; the worktree stays active', () => env(async () => {
    const rival = await take(`managed:worktree:${worktreeId}`);
    try {
      const state = async () => (await engine.getWorktreeBinding('work', hostIdFor(engine)))!.state;
      expect(await state()).toBe('active');
      const refusals = {
        prepare: await code(async () => runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'work', ...await reviewed('writer_transfer_prepare') })),
        selfPrepare: await code(async () => runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'work', self_transfer: true, ...await reviewed('writer_transfer_prepare') })),
        cancel: await code(async () => runPersistenceAdministration(engine, 'writer_transfer_cancel', { source_id: 'work', expected_epoch: '1', ...await reviewed('writer_transfer_cancel') })),
        accept: await code(async () => runPersistenceAdministration(engine, 'writer_transfer_accept', { source_id: 'work', path: root, expected_epoch: '1', manifest: 'a'.repeat(64), ...await reviewed('writer_transfer_accept') })),
      };
      expect(refusals).toEqual({ prepare: 'write_pending', selfPrepare: 'write_pending', cancel: 'write_pending', accept: 'write_pending' });
      expect(await state()).toBe('active');
    } finally { await freeLease(rival); }
  }), 180_000);

  test('shared-skill activation on a Rust brain takes the store\'s own activation, never a worktree lock: a competing lease changes nothing', () => env(async () => {
    const rival = await take(`managed:worktree:${worktreeId}`);
    try {
      const out = await code(() => activateSharedSkillPersistence(engine, { confirmQuiesced: true, dryRun: true }));
      expect(out === null || out === 'writer_not_quiesced' || out === 'writer_registration_required').toBe(true);
      expect(out).not.toBe('writer_lock_unavailable');
    } finally { await freeLease(rival); }
  }), 60_000);
});
