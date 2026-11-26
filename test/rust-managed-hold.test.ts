/**
 * The managed_persistence hold on a user's Rust brain (store-capabilities.ts HELD_FOR_CALLERS, store-members/managed-hold.ts).
 *
 * Lane LM typed the statements managed mode runs (source lifecycle under topology locks, Git durability, the Git effect
 * runner, managed link edits), so a Rust store now serves them. A user's Rust brain does not report
 * `managed_persistence`, and on it each of those steps must still refuse exactly as the executeRaw it replaced did
 * (`engine_capability_missing`, member executeRaw, capability raw_sql), before anything changed. This runs a claimed,
 * activated checkout on a Rust brain with the hold ON and checks each refusal and that the source, its pages, the
 * lifecycle receipts and the checkout files are unchanged.
 *
 * Needs the Rust addon: runs with GBRAIN_TEST_RUST_ARM=1 (as the Rust CI job does), and is skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openRustBrain, removeBrainDir, rustArmRequested, createRustSource, type RustBrainDir } from './engine-parity/rust-arm.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { assertWriterAdminUnlocked } from '../src/core/persistence/admin-lock.ts';
import { hostIdFor } from '../src/core/persistence/identity.ts';

const refusal = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string; detail?: unknown }) => ({
  code: e?.code ?? String(e), member: /member=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null, capability: /capability=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null }));
const RAW = { code: 'engine_capability_missing', member: 'executeRaw', capability: 'raw_sql' };

describe.skipIf(!rustArmRequested())('a user\'s Rust brain keeps refusing managed mode (hold on)', () => {
  let brain: RustBrainDir;
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    brain = await openRustBrain();
    engine = brain.engine as unknown as BrainEngine;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-hold-')));
  }, 60_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    removeBrainDir(brain.dir);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('lifecycle, Git durability, the coalesced claim and the admin-lock check refuse as executeRaw did; nothing changed', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
      await createRustSource(engine, 'work', {}, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      const before = { source: await engine.readSourceMembership('work'), files: readdirSync(join(root, 'notes')).sort() };
      const binding = (await engine.getWorktreeBinding('work', hostIdFor(engine)))!;

      const out = {
        archive: await refusal(() => runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'work' })),
        remove: await refusal(() => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'work', confirmDestructive: true })),
        durability: await refusal(async () => runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'work', disable: true, ...await reviewed('writer_git_durability') })),
        claim: await refusal(() => engine.claimCoalescedGitEffects({ hostId: hostIdFor(engine), worktreeId: binding.worktree_id, limit: 5, deadOwners: [], ownerJson: '{}' })),
        adminLock: await refusal(() => engine.transaction(tx => assertWriterAdminUnlocked(tx))),
        stores: await Promise.all([
          refusal(async () => (await engine.topologyStore()).readSource('work')),
          refusal(async () => (await engine.gitEffectStore()).publicationsPending(binding.worktree_id)),
          refusal(async () => (await engine.gitDurabilityStore()).bound()),
          refusal(async () => (await engine.manualLinkStore()).manualStatements(1)),
        ]),
      };
      expect(out).toEqual({ archive: RAW, remove: RAW, durability: RAW, claim: RAW, adminLock: RAW, stores: [RAW, RAW, RAW, RAW] });
      const after = { source: await engine.readSourceMembership('work'), files: readdirSync(join(root, 'notes')).sort() };
      expect(after).toEqual(before);
      expect(existsSync(join(root, 'notes', 'alice-example.md'))).toBe(true);
    }), 120_000);
});
