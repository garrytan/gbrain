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
 * Slice 2 lifted the hold for a single-host store; a multi-user store (GBRAIN_RUST_MULTIUSER=1) still withholds
 * `managed_persistence` (store-capabilities.ts MULTIUSER_WITHHELD) until slice 3 moves managed mode's locks to I-5 leases.
 * This file takes the capability off its engine exactly as a multi-user store does (RustEngine._reportStoreCapabilities),
 * on a single-host store, so each refusal is the managed gate's own and not a missing host fence; on such an engine every
 * step must still refuse exactly as before. test/rust-managed-hold.test.ts also opens a real multi-user store.
 *
 * Needs the Rust addon: runs with GBRAIN_TEST_RUST_ARM=1 (as the Rust CI job does), and is skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MULTIUSER_WITHHELD } from '../src/core/rust-engine/store-capabilities.ts';
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
import { claimedPredecessor } from '../src/core/persistence/sync-window.ts';
import { engineStallProbe } from '../src/core/persistence/sync-drain.ts';
import { retireOrphanSliceRecords } from '../src/core/persistence/sync-cursor-key.ts';
import { resolveSlugRootMode } from '../src/core/sync-anchor.ts';
import { eachStoredTimelineRow } from '../src/core/timeline-extract.ts';

const refusal = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string; detail?: unknown }) => ({
  code: e?.code ?? String(e), member: /member=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null, capability: /capability=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null }));
const RAW = { code: 'engine_capability_missing', member: 'executeRaw', capability: 'raw_sql' };
/** What a status read and the landing-gaps read of a claimed source answered on a held brain before part B typed their statements: the status refuses naming executeRaw, the landing read's own catch says `not_applicable`. */
const BASE_STATUS = { status: RAW, landing: 'not_applicable' };
/** The base's refusal of a managed sync: performManagedSync names managed_persistence before discovery. */
const SYNC_REFUSAL = { code: 'engine_capability_missing', member: 'performManagedSync', capability: 'managed_persistence' };

describe.skipIf(!rustArmRequested())('a Rust brain that withholds managed mode (a multi-user store, until slice 3) keeps refusing managed mode (withheld until slice 3)', () => {
  let brain: RustBrainDir;
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    brain = await openRustBrain();
    // What a multi-user store withholds (store-capabilities.ts MULTIUSER_WITHHELD), taken off this single-host engine.
    for (const capability of MULTIUSER_WITHHELD) (brain.engine.capabilities as Set<string>).delete(capability);
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

  test('the run, waiver, cursor-key, window, lane and stall statements refuse as the executeRaw they replaced did; no cursor row appears', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      const names = ['cursor_manifest_insert', 'cursor_insert', 'cursor_swap', 'checkpoint_touch', 'finished_cursor_delete', 'manifest_delete_unshared', 'prefix_delete'] as const;
      const reads = ['cursor_head_locked', 'pending_intent_held', 'unfinished_page_request', 'stale_page_requests', 'waiver_settings', 'waiver_pages', 'kernel_pages_by_slug',
        'kernel_page_by_id', 'cursor_open_requests', 'request_for_update', 'group_predecessor', 'request_state_by_principal', 'stall_probe', 'refused_checkpoint', 'slug_prefix_probe', 'stored_timeline_page'] as const;
      const out: Record<string, unknown> = {};
      for (const name of [...names, ...reads]) out[name] = await refusal(() => engine.runSyncStatement(name, ['x', 'y', 'z', 'w']));
      // The callers reach the same refusal through syncRows: a window read, a lane turn read, the stall probe and a cursor retirement.
      out.window = await refusal(() => claimedPredecessor(engine, { principal_kind: 'local_cli', principal_id: 'p', sequence: 5, request_id: 'r', intent: { after: '00000000-0000-4000-8000-000000000001' } } as never));
      out.stall = await refusal(() => engineStallProbe(engine).fingerprint({ managedWrite: { write_request: { request_id: '00000000-0000-4000-8000-000000000001' } } } as never));
      out.retire = await refusal(() => retireOrphanSliceRecords(engine, 'work', '00000000-0000-4000-8000-000000000001'));
      // The slug-root probe of a scoped sync (no pin stored, no explicit git root): the page probe it sent through executeRaw.
      out.slugRoot = await refusal(() => resolveSlugRootMode(engine, { sourceId: 'work', explicitGitRoot: false, slugPrefix: 'notes', dryRun: true }));
      // The managed extract's walk of a page's stored timeline rows: the keyset read it sent through executeRaw.
      out.timelineRows = await refusal(() => eachStoredTimelineRow(engine as never, 1, () => undefined));
      expect(Object.values(out).every(value => JSON.stringify(value) === JSON.stringify(RAW))).toBe(true);
      expect(Object.keys(out).length).toBe(names.length + reads.length + 5);
      expect(await engine.getPage('notes/alice-example', { sourceId: 'work' })).toBeNull();
    }), 120_000);

  test('a page with a source_path in a source-root source below its repository root is refused as before, and nothing is written', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      const repo = join(home, 'scoped-repo');
      mkdirSync(join(repo, 'sub'), { recursive: true });
      execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
      await createRustSource(engine, 'scoped', { slug_root_mode: 'source-root' }, join(repo, 'sub'));
      const page = { type: 'note' as const, title: 'Below root', compiled_truth: 'x', timeline: '', source_path: 'one.md' };
      const refused = await refusal(() => engine.putPage('notes/below-root', page, { sourceId: 'scoped' }));
      expect(refused).toEqual({ code: 'engine_capability_missing', member: 'putPage', capability: 'pages' });
      expect(await engine.getPage('notes/below-root', { sourceId: 'scoped' })).toBeNull();
      // A page with no source_path is written as before.
      await engine.putPage('notes/no-path', { type: 'note', title: 'No path', compiled_truth: 'x', timeline: '' }, { sourceId: 'scoped' });
      expect((await engine.getPage('notes/no-path', { sourceId: 'scoped' }))?.slug).toBe('notes/no-path');
    }), 120_000);
});

describe.skipIf(!rustArmRequested())('a real multi-user Rust store withholds managed mode (until slice 3)', () => {
  test('opened with GBRAIN_RUST_MULTIUSER=1, the engine does not report managed_persistence and a managed store refuses as executeRaw did', async () => {
    const saved = process.env.GBRAIN_RUST_MULTIUSER;
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    let brain: RustBrainDir | null = null;
    try {
      brain = await openRustBrain();
      const engine = brain.engine as unknown as BrainEngine;
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      expect(engine.capabilities.has('persistence_journal')).toBe(true);
      expect(await refusal(async () => (await engine.gitDurabilityStore()).hostBindingPaths())).toEqual(RAW);
    } finally {
      if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
      if (brain) { await (brain.engine as unknown as BrainEngine).disconnect(); removeBrainDir(brain.dir); }
    }
  }, 60_000);

  test('opened without the switch, the same engine reports managed_persistence (the hold is lifted on a single host)', async () => {
    const saved = process.env.GBRAIN_RUST_MULTIUSER;
    delete process.env.GBRAIN_RUST_MULTIUSER;
    let brain: RustBrainDir | null = null;
    try {
      brain = await openRustBrain();
      expect((brain.engine as unknown as BrainEngine).capabilities.has('managed_persistence')).toBe(true);
    } finally {
      if (saved !== undefined) process.env.GBRAIN_RUST_MULTIUSER = saved;
      if (brain) { await (brain.engine as unknown as BrainEngine).disconnect(); removeBrainDir(brain.dir); }
    }
  }, 60_000);
});
