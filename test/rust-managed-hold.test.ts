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
import { performSync } from '../src/commands/sync.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { assertWriterAdminUnlocked } from '../src/core/persistence/admin-lock.ts';
import { hostIdFor } from '../src/core/persistence/identity.ts';
import { SYNC_STATEMENTS, type SyncStatementName } from '../src/core/engine-sql/managed-sync-store.ts';
import { idempotentDeletionProof, pageChangeProof } from '../src/core/persistence/sync-page-fault.ts';
import { readDryRunWriterState } from '../src/core/persistence/sync-dry-run-writer.ts';
import { recordedStop } from '../src/core/persistence/sync-stop-class.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { readLandingGaps } from '../src/core/persistence/landing-gaps.ts';
import { sweepNeedsHumanHolds, recordSoakEvent } from '../src/core/persistence/soak-counters.ts';

const refusal = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string; detail?: unknown }) => ({
  code: e?.code ?? String(e), member: /member=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null, capability: /capability=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null }));
const RAW = { code: 'engine_capability_missing', member: 'executeRaw', capability: 'raw_sql' };
/** What a status read and the landing-gaps read of a claimed source answered on a held brain before part B typed their statements: the status refuses naming executeRaw, the landing read's own catch says `not_applicable`. */
const BASE_STATUS = { status: RAW, landing: 'not_applicable' };
/** The base's refusal of a managed sync: performManagedSync names managed_persistence before discovery. */
const SYNC_REFUSAL = { code: 'engine_capability_missing', member: 'performManagedSync', capability: 'managed_persistence' };

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

  test('a managed sync and a direct runSyncStatement refuse as before; nothing is imported or stamped', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      // The claimed checkout the case before it set up, or its own when this case runs alone.
      const root = join(home, 'checkout');
      if (!await engine.getSource('work')) {
        mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
        writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
        await createRustSource(engine, 'work', {}, root);
        const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
        await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      }
      const before = { source: await engine.readSourceMembership('work'), stamped: (await engine.getSource('work'))?.last_sync_at ?? null,
        page: await engine.getPage('notes/alice-example', { sourceId: 'work' }), files: readdirSync(join(root, 'notes')).sort() };
      const out = {
        // performManagedSync names its capability before discovery (sync-run.ts, requireManagedPersistence): managed_persistence.
        sync: await refusal(() => performSync(engine, { sourceId: 'work', repoPath: root, noPull: true, noEmbed: true, noExtract: true })),
        // The member that replaced executeRaw refuses as executeRaw did, on a read and on a write statement.
        statementRead: await refusal(() => engine.runSyncStatement('source_row', ['work'])),
        statementWrite: await refusal(() => engine.runSyncStatement('checkpoint_delete', ['managed-sync-tail', 'work'])),
      };
      expect(out).toEqual({ sync: SYNC_REFUSAL, statementRead: RAW, statementWrite: RAW });
      const after = { source: await engine.readSourceMembership('work'), stamped: (await engine.getSource('work'))?.last_sync_at ?? null,
        page: await engine.getPage('notes/alice-example', { sourceId: 'work' }), files: readdirSync(join(root, 'notes')).sort() };
      expect(after).toEqual(before);
      expect(after.page).toBeNull();
      expect(after.stamped).toBeNull();
    }), 120_000);
  /** The statements of the page-fault proofs, the older cursor's publication, `sync status`, the hold sweep and the freshness read (lane LM slice 2, part B). */
  const PART_B: SyncStatementName[] = ['page_revision_writer', 'request_writer', 'page_deleted_revision_writer', 'live_page_at_origin', 'manifest_entry', 'cursor_keys_locked', 'manifest_length',
    'cursor_mark_done', 'failure_supersession', 'source_company_brain', 'source_live_incarnation', 'knock_on_requests', 'live_cursor_rows', 'open_writer_requests', 'recorded_stop',
    'freshness_aggregate', 'soak_counter_add', 'hold_needs_human_stamp', 'landing_binding', 'landing_receipts', 'landing_live_slugs'];

  test('the page-fault proofs, the dry-run writer state, the stop record, the hold sweep and every part-B statement refuse as executeRaw did; nothing changed', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      const root = join(home, 'checkout');
      if (!await engine.getSource('work')) {
        mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
        writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
        await createRustSource(engine, 'work', {}, root);
        const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
        await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      }
      const incarnation = (await engine.readSourceMembership('work'))!.incarnation;
      const before = { source: await engine.readSourceMembership('work'), page: await engine.getPage('notes/alice-example', { sourceId: 'work' }), files: readdirSync(join(root, 'notes')).sort() };
      const statements = Object.fromEntries(await Promise.all(PART_B.map(async name => [name, await refusal(() => engine.runSyncStatement(name, ['work', 'work', 'work', 'work'])).then(r => ({ kind: (SYNC_STATEMENTS as Record<string, { kind: string } | undefined>)[name]?.kind ?? 'new', ...r }))])));
      const out = {
        pageChange: await refusal(() => pageChangeProof(engine, { sourceId: 'work', incarnation, pageId: 1, expectedRevision: 'revision-example' })),
        deletion: await refusal(() => idempotentDeletionProof(engine, { sourceId: 'work', incarnation, pageId: 1, revision: 'revision-example', sourcePath: 'notes/alice-example.md' })),
        dryRunWriter: await refusal(() => readDryRunWriterState(engine, 'work')),
        recordedStop: await refusal(() => recordedStop(engine, 'cursor-example', 'run-example')),
        sweep: await refusal(() => sweepNeedsHumanHolds(engine, 'work')),
      };
      // The soak counter write never throws (its refusal is swallowed by design); the row it would add is not there.
      await recordSoakEvent(engine as never, 'needs_human', 1);
      expect(out).toEqual({ pageChange: RAW, deletion: RAW, dryRunWriter: RAW, recordedStop: RAW, sweep: RAW });
      expect(Object.values(statements).every(r => (r as { code: string }).code === RAW.code && (r as { member: string }).member === RAW.member && (r as { capability: string }).capability === RAW.capability)).toBe(true);
      expect(Object.keys(statements).sort()).toEqual([...PART_B].sort());
      // A status read of a source the hold keeps out of managed mode answers what it did before this part typed its statements.
      const status = await refusal(() => readSyncStatus(engine, 'work'));
      const landing = await readLandingGaps(engine, 'work').then(r => r.status, (e: { code?: string }) => `refused: ${e?.code}`);
      expect({ status, landing }).toEqual(BASE_STATUS);
      const after = { source: await engine.readSourceMembership('work'), page: await engine.getPage('notes/alice-example', { sourceId: 'work' }), files: readdirSync(join(root, 'notes')).sort() };
      expect(after).toEqual(before);
      expect(after.page).toBeNull();
    }), 120_000);
});
