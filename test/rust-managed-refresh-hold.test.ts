/**
 * The managed_persistence hold on the refresh, barrier, import-hold and group paths of a user's Rust brain
 * (store-capabilities.ts HELD_FOR_CALLERS, store-members/managed-hold.ts, persistence/worktree-refresh.ts).
 *
 * Lane LM typed the refresh writer (`refreshStore`), the held-write statements and the grouped publication
 * (`groupPublishStore`). A user's Rust brain reports neither `managed_persistence` nor `raw_sql`, so with the hold ON each of
 * those steps must refuse exactly as it did before they were typed: `gbrain sources refresh` by its own name (capability
 * raw_sql, nothing written), a page write and a put_pages group at their worktree admission (managed_persistence), the import
 * hold's count, the deferral room, the refresh timing and the synced-refresh completion by the answers they gave before, and each method of the two new stores through the engine's executeRaw. The members whose answers lane
 * LM fixed (`stampWriteClaim`'s passed_sync and the active, stuck and resumable refresh lists) answer as before. Each refusal
 * comes before any change: the store (including a refresh row written straight to the store), the checkout and the home
 * directory are unchanged.
 *
 * Slice 2 lifted the hold: a single-host Rust engine reports `managed_persistence`. This file takes the capability off its
 * own engine instance, as a build that does not serve managed mode reports it, so each refusal is the managed gate's own and
 * every step must still refuse exactly as it did while the hold was on. Managed mode on a multi-user Rust store waits for
 * the multi-user branch (slice 3).
 *
 * Needs the Rust addon: runs with GBRAIN_TEST_RUST_ARM=1 (as the Rust CI job does), and is skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openRustBrain, removeBrainDir, rustArmRequested, createRustSource, type RustBrainDir } from './engine-parity/rust-arm.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { RustEngine } from '../src/core/rust-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { hostIdFor, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { importManagedFiles } from '../src/core/persistence/import-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

const refusal = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string; detail?: unknown }) => ({
  code: e?.code ?? String(e), member: /member=(.+?) capability=/.exec(String(e?.detail ?? ''))?.[1]?.split(' (')[0] ?? null,
  capability: /capability=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null, written: /written=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null }));
const RAW = { code: 'engine_capability_missing', member: 'executeRaw', capability: 'raw_sql', written: 'nothing' };
const member = (name: string, capability = 'managed_persistence') => ({ code: 'engine_capability_missing', member: name, capability, written: 'nothing' });
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\nWorks at widget-co.\n`;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8' }).trim();

describe.skipIf(!rustArmRequested())('a Rust brain without managed_persistence keeps refusing the refresh, barrier, import-hold and group paths (hold on)', () => {
  let brain: RustBrainDir;
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    brain = await openRustBrain();
    // The capability a build that does not serve managed mode lacks, taken off this engine instance.
    (brain.engine.capabilities as Set<string>).delete('managed_persistence');
    engine = brain.engine as unknown as BrainEngine;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-refresh-hold-')));
  }, 60_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    removeBrainDir(brain.dir);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('refresh, a write during a refresh, the import hold, a put_pages group and the new stores refuse as before; nothing changed', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REFRESH_BARRIER: '1' }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      expect(engine.capabilities.has('raw_sql')).toBe(false);
      const remote = join(home, 'origin.git'), upstream = join(home, 'upstream'), root = join(home, 'checkout');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      execFileSync('git', ['clone', '-q', remote, upstream], { stdio: 'ignore' });
      git(upstream, 'checkout', '-q', '-b', 'main');
      mkdirSync(join(upstream, 'notes'), { recursive: true });
      writeFileSync(join(upstream, 'notes', 'alice-example.md'), page('Alice Example'));
      git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'notes'); git(upstream, 'push', '-q', 'origin', 'main');
      execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
      // A new upstream commit a refresh would fast-forward to.
      writeFileSync(join(upstream, 'notes', 'bob-example.md'), page('Bob Example'));
      git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'bob'); git(upstream, 'push', '-q', 'origin', 'main');
      await createRustSource(engine, 'work', { remote_url: remote }, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      const host = hostIdFor(engine);
      const binding = (await engine.getWorktreeBinding('work', host))!;
      const store = (engine as unknown as RustEngine).openStore('refreshHold').brain as unknown as {
        refreshWrite(input: Record<string, unknown>): Promise<unknown>; refreshRows(input: Record<string, unknown>): Promise<unknown>;
      };
      // A refresh row written straight to the store (a refresh cannot start here), which the held members must not show.
      const row = await store.refreshWrite({ kind: 'insert_draining', worktreeId: binding.worktree_id, sourceIds: ['work'], principalId: randomUUID(), ownerEpoch: '1',
        topologyGeneration: '1', oldHead: 'a'.repeat(40), targetHead: 'b'.repeat(40), upstreamRef: 'origin/main', preserved: [], outcome: {} }) as { id: string };

      writeFileSync(join(root, 'notes', 'dora-example.md'), page('Dora Example'));
      const snapshot = async () => ({ source: await engine.readSourceMembership('work'), binding: await engine.getWorktreeBinding('work', host),
        refreshRow: JSON.stringify(await store.refreshRows({ kind: 'row', id: row.id })), head: git(root, 'rev-parse', 'HEAD'), notes: readdirSync(join(root, 'notes')).sort(),
        home: readdirSync(home).sort(), gitConfig: readFileSync(join(root, '.git', 'config'), 'utf8'),
        page: (await engine.getPage('notes/carol-example', { sourceId: 'work' }))?.title ?? null });
      const before = await snapshot();

      const ctx = { engine, sourceId: 'work', remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const { operationsByName } = await import('../src/core/operations.ts');
      const out = {
        refresh: await refusal(() => refreshWorktree(engine, 'work')),
        dryRun: await refusal(() => refreshWorktree(engine, 'work', { dryRun: true })),
        resume: await refusal(() => refreshWorktree(engine, 'work', { resume: true })),
        // A page write while a refresh row exists: refused at the worktree admission, as with no refresh.
        write: await refusal(() => submitPageMutation(ctx as never, { operation: 'put_page', params: { slug: 'notes/carol-example', content: page('Carol Example'), request_id: randomUUID() } })),
        putPages: await refusal(() => operationsByName.put_pages!.handler(ctx as never, { request_id: randomUUID(), wait_ms: 0,
          pages: ['notes/eve-example', 'notes/fay-example'].map(slug => ({ slug, content: page(slug)})) })),
        importFiles: await refusal(async () => { const [r] = await importManagedFiles(engine, [{ filePath: join(root, 'notes', 'dora-example.md'), sourcePath: 'notes/dora-example.md' }], { sourceId: 'work', noEmbed: true });
          if (r?.status === 'rejected') throw r.reason; }),
        heldCount: await engine.countHeldBehindImport('work', null),
        deferralRoom: await engine.hasDeferralRoom(binding.worktree_id, 'refresh_barrier_1', 60_000),
        timing: await engine.readRefreshTiming(row.id),
        completeSynced: await engine.completeSyncedRefresh(row.id),
        stores: await Promise.all([
          refusal(async () => (await engine.refreshStore()).readActive(binding.worktree_id)),
          refusal(async () => (await engine.refreshStore()).insertDraining({ worktreeId: binding.worktree_id, sourceIds: ['work'], principalId: randomUUID(), ownerEpoch: '1',
            topologyGeneration: '1', oldHead: 'a', targetHead: 'b', upstreamRef: 'o', preserved: [], outcome: {} })),
          refusal(async () => (await engine.refreshStore()).drainCounts(binding.worktree_id)),
          refusal(async () => (await engine.groupPublishStore()).importRoots(host)),
          refusal(async () => (await engine.groupPublishStore()).recoveryBlocked(binding.worktree_id, [])),
          refusal(async () => (await engine.groupPublishStore()).claimFollowers({ worktree_id: binding.worktree_id, sequence: 0 }, 'batch:x', 3, 1000, {})),
        ]),
      };
      expect(out).toEqual({
        refresh: member('the refresh writer', 'raw_sql'), dryRun: member('the refresh writer', 'raw_sql'), resume: member('the refresh writer', 'raw_sql'),
        write: member('admitWrite'), putPages: member('admitWriteGroupInTransaction'), importFiles: RAW,
        // These members answered on a Rust brain before the refresh was typed, and answer the same: none held, a consumer-free worktree has room,
        // the timing of a refresh row that exists, and no syncing refresh to complete.
        heldCount: { count: 0, bytes: 0 }, deferralRoom: true, timing: { elapsed_ms: expect.any(Number), typical_ms: null }, completeSynced: false,
        stores: [RAW, RAW, RAW, RAW, RAW, RAW] });
      expect(await snapshot()).toEqual(before);
      expect(existsSync(join(root, 'notes', 'bob-example.md'))).toBe(false);

      // The listings answer as they did before refresh rows existed here, though the store holds one.
      expect(JSON.parse(String(before.refreshRow)).state).toBe('draining');
      expect(await engine.listActiveWorktreeRefreshRows(null)).toEqual([]);
      expect(await engine.listStuckWorktreeRefreshes(0)).toEqual([]);
      expect(await engine.listResumableRefreshes(host, 0)).toEqual([]);
    }), 120_000);

  test('the claim stamp keeps passed_sync false, and every unbound claim answers as before', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      const host = hostIdFor(engine);
      const defaultSource = await engine.readSourceMembership('default');
      const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as OperationContext;
      const authority = await submissionAuthority(ctx, 'put_page', 'default', defaultSource!.incarnation, 'notes/claimed');
      for (const [slug, requestId] of [['notes/claimed', 'c0000000-0000-4000-8000-0000000000d1']] as const) {
        await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: defaultSource!.incarnation,
          slug, requestId, callerIntent: { body: 'x' }, intent: { body: 'x' } });
      }
      const claimed = await claimNextWrite(engine, host, 60_000) as (Record<string, unknown> | null);
      expect(claimed?.state).toBe('running');
      expect(claimed?.passed_sync).toBe(false);
      // A write that follows a queued managed-sync row of its worktree: the SQL engines report passed_sync true for its claim, a held
      // Rust brain keeps reporting false.
      const work = (await engine.readSourceMembership('work'))!;
      const binding = (await engine.getWorktreeBinding('work', host))!;
      const insert = (requestId: string, intent: Record<string, unknown>) => engine.insertWriteRequest({ principalKind: authority.principal.kind, principalId: authority.principal.id,
        requestId, operation: 'put_page', sourceId: 'work', sourceIncarnation: work.incarnation, pageId: null, slug: 'notes/after-sync', worktreeId: binding.worktree_id,
        topologyGeneration: binding.topology_generation, digest: 'd', intent, authority, intentBytes: 1, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1,
        admitterVersion: 'v', admitterHostId: host, counterKeys: [], clientRequestId: null, state: 'queued', deferredRefreshId: null } as never);
      await insert('c0000000-0000-4000-8000-0000000000e1', { kind: 'managed_sync_import' });
      const later = await insert('c0000000-0000-4000-8000-0000000000e2', { body: 'x' });
      const stamped = await engine.stampWriteClaim(later.id, 'c0000000-0000-4000-8000-0000000000e3', 60_000, '{}');
      expect({ state: stamped?.state, passed_sync: stamped?.passed_sync }).toEqual({ state: 'running', passed_sync: false });
    }), 120_000);
});
