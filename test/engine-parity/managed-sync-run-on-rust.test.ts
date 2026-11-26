/**
 * Engine parity: the managed sync's run machinery on a Rust brain (lane LM, slice 2: sync-run.ts, sync-waivers.ts,
 * sync-cursor-key.ts, sync-window.ts, sync-lanes.ts, sync-drain.ts, sync-pass-fold.ts, noop-kernel.ts).
 *
 * Every case lifts the `managed_persistence` hold on its own Rust test engine (rust-managed.ts `liftManagedHold`), runs the
 * path on a claimed, activated Git checkout, and returns its answers; PGLite, Postgres and Rust must return the same.
 * `servedCapabilities()` still withholds the capability, and the arm fails a case that meets one raw-SQL refusal, caught or not.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a `--drain` sync imports like a plain one; an entry
 *    refused after its admission because its file changed is held `worktree_dirty` under the hold gate, and the others import;
 *    a legacy cursor row a pass finds (finished, and its frozen manifest) is retired by the first pass; a no-op delete waives
 *    through the waiver transaction; the window, lane and stall reads answer the predecessor and the head they name. Each is
 *    equal on every arm.
 *  - Regression: each read went through `executeRaw`, which the Rust engine refuses (the hold
 *    gate, the waiver transaction, the cursor retirement, the lane turn, the stall probe, the folded stamp's refusal read).
 *  - Why existing coverage misses it: those suites run PGLite and Postgres only; sync-stamp.test.ts counts a Rust refusal as a
 *    named stop.
 *  - Seam: real engines and real Git checkouts; one fault hook (`sync:after_freeze`) edits a file after its freeze, the seam
 *    sync-pass-dirty-after-freeze-gbra130.test.ts uses. The statement cases drive `runSyncStatement` by name over rows the
 *    typed members seed.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, writeCheckpointAt, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { seedTypedRequest } from '../helpers/persistence-typed-seed.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { waiveNoopRun, type WaiverCursor, type WaiverRunEntry } from '../../src/core/persistence/sync-waivers.ts';
import { claimedHeadOrder, claimedPredecessor } from '../../src/core/persistence/sync-window.ts';
import { awaitLaneTurn, type LaneState } from '../../src/core/persistence/sync-lanes.ts';
import { engineStallProbe } from '../../src/core/persistence/sync-drain.ts';
import { resolveBulkSettings } from '../../src/core/persistence/sync-group.ts';
import type { SyncStatementName } from '../../src/core/engine-sql/managed-sync-store.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';

type OrderedRow = Parameters<typeof claimedPredecessor>[1];
const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, ...GIT_ID, 'commit', '-qm', message); };

type SyncResult = { status: string; held?: Array<{ path: string; code: string }>; reason?: string };
type Sync = (extra?: Record<string, unknown>) => Promise<SyncResult>;

/** Lifts the hold on the Rust arm's engine, then runs `run` with source `work` claimed and activated on a Git checkout. */
async function withManagedSource<T>(engine: BrainEngine, backend: ParityBackend, files: Record<string, string>,
  run: (root: string, sync: Sync, incarnation: string) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-sync-run-on-rust-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      git(root, 'init', '-q', '-b', 'main');
      for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
      commit(root, 'notes');
      await createSource(engine, backend, 'work', {}, root);
      try {
        const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
        await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
        // A raw-SQL refusal is rethrown (the arm reads it); any other error ends the sync as a status word the arms compare.
        const sync: Sync = (extra = {}) => performSync(engine, { sourceId: 'work', repoPath: root, noPull: true, noEmbed: true, noExtract: true, ...extra } as never)
          .then(r => r as SyncResult, (error: { code?: string }) => {
            if (error?.code === 'engine_capability_missing') throw error;
            return { status: `refused: ${error?.code ?? String(error)}` };
          });
        return await run(root, sync, (await engine.readSourceMembership('work'))!.incarnation);
      } finally { await disposePersistenceConsumer(engine); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const slugsOf = async (engine: BrainEngine) => (await engine.listPages({ sourceId: 'work', limit: 100 })).map(page => page.slug).sort();
const pageText = async (engine: BrainEngine, slug: string) => ((await engine.getPage(slug, { sourceId: 'work' }))?.compiled_truth ?? '').trim();
const holdsOf = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['work'] }))[0]?.holds ?? []).map(hold => `${hold.path}:${hold.code}`).sort();
const named = <R = Record<string, unknown>>(engine: BrainEngine, name: SyncStatementName, params: unknown[] = []) => engine.runSyncStatement<R>(name, params);

describe('the managed sync run on a Rust brain', () => {
  parityTest('managed mode is served on a single-host Rust brain', { methods: ['getConfig'] }, async engine => {
    await engine.getConfig('managed_sync_run_on_rust_probe');
    const out = { served: servedCapabilities().has('managed_persistence') };
    expect(out).toEqual({ served: true });
    return out;
  });

  parityTest('a drain imports like a plain sync, and a second drain applies the next commit', {
    methods: ['worktreeClaimStore', 'listPages', 'getSource'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'),
    'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async (root, sync) => {
    const stampedBefore = (await engine.getSource('work'))?.last_sync_at != null;
    const first = await sync({ drain: true });
    writeFileSync(join(root, 'notes', 'carol-example.md'), note('Carol Example', 'Works at initech-example.'));
    commit(root, 'add carol');
    const second = await sync({ drain: true });
    const out = { stampedBefore, first: first.status, second: second.status, pages: await slugsOf(engine) };
    expect(out).toMatchObject({ stampedBefore: false, first: 'first_sync', second: 'synced' });
    expect(out.pages).toEqual(['notes/alice-example', 'notes/bob-example', 'notes/carol-example']);
    return out;
  }));

  parityTest('a file edited after its freeze is held worktree_dirty under the hold gate and the other files import', {
    methods: ['worktreeClaimStore', 'listPages', 'getPage'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/a.md': note('Note A', 'first a.'), 'notes/b.md': note('Note B', 'first b.'), 'notes/c.md': note('Note C', 'first c.'),
  }, async (root, sync) => {
    const first = await sync();
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${name}.md`), note(`Note ${name.toUpperCase()}`, `revised ${name}.`));
    commit(root, 'revise');
    installFaultHook(async (point, detail) => {
      if (point === 'sync:after_freeze' && detail.path === 'notes/b.md') writeFileSync(join(root, 'notes/b.md'), note('Note B', 'uncommitted b.'));
    });
    let second: SyncResult;
    try { second = await sync(); } finally { installFaultHook(undefined); }
    const out = { first: first.status, second: second.status, held: (second.held ?? []).map(hold => `${hold.path}:${hold.code}`), holds: await holdsOf(engine),
      a: await pageText(engine, 'notes/a'), b: await pageText(engine, 'notes/b'), c: await pageText(engine, 'notes/c') };
    expect(out).toEqual({ first: 'first_sync', second: 'synced', held: ['notes/b.md:worktree_dirty'], holds: ['notes/b.md:worktree_dirty'],
      a: 'revised a.', b: 'first b.', c: 'revised c.' });
    return out;
  }));

  parityTest('a legacy cursor a pass finds is retired by the first pass: its row, its manifest and its slice records', {
    methods: ['worktreeClaimStore', 'listPages', 'runSyncStatement'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') },
    async (_root, sync, incarnation) => {
      const at = '2026-01-01T00:00:00.000Z';
      const header = (runId: string, done: boolean) => [{ sourceId: 'work', incarnation, runId, done, index: 1, total: 1, entries: undefined, companyReceiptId: null }];
      await writeCheckpointAt(engine, backend, 'managed-sync', 'legacy-finished', header('run-finished', true), at);
      await writeCheckpointAt(engine, backend, 'managed-sync-manifest', 'run-finished', [{ action: 'import', path: 'notes/old.md', slug: 'notes/old' }], at);
      await writeCheckpointAt(engine, backend, 'managed-sync-manifest', 'run-shared', [{ action: 'import', path: 'notes/keep.md', slug: 'notes/keep' }], at);
      await writeCheckpointAt(engine, backend, 'managed-sync-slice', `work:${incarnation}:notes`, [{ target: 'abc' }], at);
      const before = {
        cursors: (await named<{ key: string; done: boolean }>(engine, 'cursor_rows', ['work', incarnation])).map(row => `${row.key}:${row.done}`),
        manifests: (await named(engine, 'checkpoint_keys', ['managed-sync-manifest', 'run-finished'])).length,
      };
      const first = await sync();
      const after = {
        cursors: (await named<{ key: string }>(engine, 'cursor_rows', ['work', incarnation])).map(row => row.key),
        finishedManifest: (await named(engine, 'checkpoint_keys', ['managed-sync-manifest', 'run-finished'])).length,
        sharedManifest: (await named(engine, 'checkpoint_keys', ['managed-sync-manifest', 'run-shared'])).length,
        slices: (await named(engine, 'checkpoint_prefix', ['managed-sync-slice', `work:${incarnation}:`])).length,
      };
      const out = { before, first: first.status, after, pages: await slugsOf(engine) };
      expect(out.before).toEqual({ cursors: ['legacy-finished:true'], manifests: 1 });
      expect(out.after.cursors).toEqual([]);
      expect(out.after.finishedManifest).toBe(0);
      expect(out.after.sharedManifest).toBe(1);
      return out;
    }));
});

/** A deleted page of source `work` (its file synced and then removed), as a waiver sees it. */
async function deletedPage(engine: BrainEngine, root: string, sync: Sync, slug: string) {
  expect((await sync()).status).toBe('first_sync');
  unlinkSync(join(root, 'notes', `${slug.split('/')[1]}.md`));
  commit(root, `delete ${slug}`);
  expect((await sync()).status).toBe('synced');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'work', includeDeleted: true });
  return { pageId: snapshot!.page.id, revision: snapshot!.revision };
}

describe('the waiver transaction, the window, lane and stall reads on a Rust brain', () => {
  parityTest('a no-op delete waives through its transaction, and an unfinished request for the page stops the prefix', {
    methods: ['worktreeClaimStore', 'readPageSnapshot', 'getWorktreeBinding', 'insertWriteRequest', 'runSyncStatement'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'), 'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async (root, sync, incarnation) => {
    const bob = await deletedPage(engine, root, sync, 'notes/bob-example');
    await disposePersistenceConsumer(engine);
    const binding = (await getWorktreeBinding(engine, 'work'))!;
    const key = 'legacy-cursor';
    await writeCheckpointAt(engine, backend, 'managed-sync', key, [{ sourceId: 'work', incarnation, runId: 'run-1', done: false, index: 0, total: 1 }], '2026-01-01T00:00:00.000Z');
    const cursor = { sourceId: 'work', incarnation, root, gitRoot: root, slugMode: 'git-root', binding: { worktree_id: binding.worktree_id }, authority: {} as WaiverCursor['authority'],
      runId: 'run-1', index: 0 } as WaiverCursor;
    const entry = (): WaiverRunEntry => ({ pending: { requestId: '00000000-0000-4000-8000-0000000000b0', slug: 'notes/bob-example', pageId: Number(bob.pageId),
      intent: { kind: 'managed_sync_delete', path: 'notes/bob-example.md', sourcePath: 'notes/bob-example.md', expected_revision: bob.revision, ownerEpoch: String(binding.owner_epoch) } as never },
      waived: { kind: 'delete', kernel: [] } });
    const advance = async (_tx: BrainEngine, prefix: readonly WaiverRunEntry[]) => ({ ...cursor, index: prefix.length });
    const reread = async () => cursor;
    const waived = await waiveNoopRun(engine, cursor, [entry()], key, advance, reread);
    // A request still open for the page: the same run waives nothing.
    await seedWorktreeRequest(engine, binding, { slug: 'notes/bob-example', requestId: '00000000-0000-4000-8000-0000000000c1', state: 'queued', pageId: Number(bob.pageId) });
    const blocked = await waiveNoopRun(engine, cursor, [entry()], key, advance, reread);
    // A cursor that moved: the waiver rereads and waives nothing.
    await named(engine, 'checkpoint_delete', ['managed-sync', key]);
    await writeCheckpointAt(engine, backend, 'managed-sync', key, [{ sourceId: 'work', incarnation, runId: 'run-2', done: false, index: 0, total: 1 }], '2026-01-01T00:00:00.000Z');
    const moved = await waiveNoopRun(engine, cursor, [entry()], key, advance, reread);
    const out = { waived: waived && { waived: waived.waived, index: waived.cursor.index }, blocked: blocked && { waived: blocked.waived, index: blocked.cursor.index },
      moved: moved && { waived: moved.waived, index: moved.cursor.index } };
    expect(out).toEqual({ waived: { waived: 1, index: 1 }, blocked: null, moved: { waived: 0, index: 0 } });
    return out;
  }));

  parityTest('the window and lane reads name the request a group member or head follows', {
    methods: ['insertWriteRequest', 'readWriteRequestById', 'transaction'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') }, async () => {
    const seed = async (requestId: string, state: 'queued' | 'committed' | 'failed', intent: Record<string, unknown>) => {
      const row = await seedTypedRequest(engine, { source: 'work', slug: `notes/${requestId.slice(-2)}`, state, requestId, principalId: 'lanes', intent });
      const stored = (await engine.readWriteRequestById(row.id))!;
      return { id: row.id, requestId, stored: { principal_kind: stored.principal_kind, principal_id: stored.principal_id, sequence: stored.sequence, request_id: requestId, intent } as unknown as OrderedRow };
    };
    const ids = { head: '00000000-0000-4000-8000-0000000000a1', member1: '00000000-0000-4000-8000-0000000000a2', member2: '00000000-0000-4000-8000-0000000000a3', next: '00000000-0000-4000-8000-0000000000a4' };
    const head = await seed(ids.head, 'committed', { group: ids.head });
    const member1 = await seed(ids.member1, 'queued', { group: ids.head, after: ids.head });
    const member2 = await seed(ids.member2, 'queued', { group: ids.head, after: ids.member1 });
    const next = await seed(ids.next, 'queued', { group: ids.next, after: ids.member2 });
    const lane: LaneState = { coordinationPath: null, claimed: new Set(), begun: new Set(), tasks: 0, closing: false } as unknown as LaneState;
    const stored1 = (await engine.readWriteRequestById(member1.id))!, stored2 = (await engine.readWriteRequestById(member2.id))!;
    const label = (value: { state: string; requestId: string | null } | null) => value && { state: value.state, follows: Object.entries(ids).find(([, id]) => id === value.requestId)?.[0] ?? value.requestId };
    const out = {
      member2: label(await claimedPredecessor(engine, member2.stored)),
      next: label(await claimedPredecessor(engine, next.stored)),
      orphan: label(await claimedPredecessor(engine, { ...next.stored, intent: { group: '00000000-0000-4000-8000-0000000000ff', after: '00000000-0000-4000-8000-0000000000fe' } } as OrderedRow)),
      headOrder: [await claimedHeadOrder(engine, member2.stored, true), await claimedHeadOrder(engine, member1.stored, true), await claimedHeadOrder(engine, member1.stored, false)],
      // The turn after a committed predecessor is the lane's at once; after an unfinished one it gives its slot back.
      turn: await engine.transaction(async tx => ({
        afterCommitted: await awaitLaneTurn(tx, lane, [{ ...stored1, intent: { after: ids.head } } as never], 1_000).then(() => 'turn', (e: Error) => e.message),
        afterQueued: await awaitLaneTurn(tx, lane, [{ ...stored2, intent: { after: ids.member1 } } as never], 1_000).then(() => 'turn', (e: Error) => e.message),
      })),
    };
    expect(out.member2).toEqual({ state: 'queued', follows: 'member1' });
    expect(out.next).toEqual({ state: 'queued', follows: 'member2' });
    expect(out.headOrder).toEqual(['wait', null, null]);
    return out;
  }));

  parityTest('the stall probe reads the request, the head of its worktree and the worktree owner', {
    methods: ['getWorktreeBinding', 'insertWriteRequest', 'worktreeClaimStore'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') }, async () => {
    const binding = (await getWorktreeBinding(engine, 'work'))!;
    const waiting = await seedWorktreeRequest(engine, binding, { slug: 'notes/waiting', requestId: '00000000-0000-4000-8000-0000000000d1', state: 'queued' });
    const probe = engineStallProbe(engine);
    const stamp = (id: string) => ({ managedWrite: { write_request: { request_id: id } } }) as never;
    const found = await probe.fingerprint(stamp(waiting.id));
    const out = { key: (found?.key ?? '').replace(waiting.id, '<head>'), none: await probe.fingerprint(stamp('00000000-0000-4000-8000-000000000000')),
      ownerHere: found?.stall.owner_is_this_host ?? null, headIsItself: found?.stall.head_request_id === waiting.id };
    expect(out.key).toBe('queued||<head>|queued||||');
    return out;
  }));

  parityTest('bulk groups and lanes stay off on every engine that is not Postgres, so the group and lane statements never run there', {
    methods: ['getConfig'], timeout: 120_000,
  }, async (engine, backend) => {
    const settings = await resolveBulkSettings(engine, false);
    // The only engine with bulk groups is Postgres: the rest publish page by page and the Postgres-only sites of sync-run.ts never run.
    expect(settings.enabled).toBe(backend === 'postgres');
    if (backend !== 'postgres') expect(settings.lanes).toBe(1);
    return { enabledOnPostgresOnly: settings.enabled === (backend === 'postgres') };
  });
});

/** Admits one request bound to the claimed worktree (the typed seed binds none); `queued` leaves it open. */
async function seedWorktreeRequest(engine: BrainEngine, binding: { worktree_id: string; topology_generation: number | string }, r: { slug: string; requestId: string; state: 'queued' | 'failed' | 'committed'; pageId?: number; intent?: Record<string, unknown> }) {
  const source = (await engine.readSourceMembership('work'))!;
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'run-seed', requestId: r.requestId, operation: 'put_page', sourceId: 'work', sourceIncarnation: source.incarnation,
    pageId: r.pageId ?? null, slug: r.slug, worktreeId: binding.worktree_id, topologyGeneration: Number(binding.topology_generation), digest: 'x', intent: r.intent ?? {}, authority: {},
    intentBytes: 0, terminalReservation: 0, targetKind: 'page', protocolVersion: 1, admitterVersion: 'v-run-seed', admitterHostId: null, counterKeys: [], clientRequestId: null,
    state: 'queued', deferredRefreshId: null,
  } as never);
  return { id: row.id as string };
}

describe('the named statements of the run block answer the rows their text answers, on every engine', () => {
  parityTest('cursor rows: insert once, swap on the header read, touch, head read, intent read, retire and prefix delete', {
    methods: ['runSyncStatement'], timeout: 120_000,
  }, async (engine, backend) => {
    if (backend === 'rust') liftManagedHold(engine);
    const head = (extra: Record<string, unknown> = {}) => [{ sourceId: 'work', incarnation: 'inc', runId: 'run-a', index: 2, total: 3, pending: { requestId: 'req-1', intent: { kind: 'managed_sync_import', path: 'a.md' } }, ...extra }];
    const cursor = async (key: string) => (await named<{ completed_keys: unknown }>(engine, 'checkpoint_keys', ['managed-sync', key]))[0]?.completed_keys ?? null;
    const out: Record<string, unknown> = {};
    out.manifestInsert = await named(engine, 'cursor_manifest_insert', ['managed-sync-manifest', 'run-a', JSON.stringify([{ action: 'import', slug: 'a' }])]);
    out.manifestAgain = await named(engine, 'cursor_manifest_insert', ['managed-sync-manifest', 'run-a', JSON.stringify([{ action: 'import', slug: 'zzz' }])]);
    out.manifest = (await named<{ completed_keys: unknown }>(engine, 'checkpoint_keys', ['managed-sync-manifest', 'run-a']))[0]?.completed_keys;
    out.insert = await named(engine, 'cursor_insert', ['managed-sync', 'k1', JSON.stringify(head())]);
    out.insertAgain = await named(engine, 'cursor_insert', ['managed-sync', 'k1', JSON.stringify(head({ index: 9 }))]);
    out.afterInsert = await cursor('k1');
    out.swapLost = await named(engine, 'cursor_swap', ['managed-sync', 'k1', JSON.stringify(head({ index: 7 })), JSON.stringify(head({ index: 3 }))]);
    // The compare reads the value, not its key order.
    const reordered = head(); const reorderedHead = reordered[0] as Record<string, unknown>;
    const shuffled = [Object.fromEntries(Object.entries(reorderedHead).reverse())];
    out.swapWon = await named(engine, 'cursor_swap', ['managed-sync', 'k1', JSON.stringify(shuffled), JSON.stringify(head({ index: 3, done: true }))]);
    out.afterSwap = await cursor('k1');
    out.touch = await named(engine, 'checkpoint_touch', ['managed-sync-manifest', 'run-a']);
    out.touchMissing = await named(engine, 'checkpoint_touch', ['managed-sync-manifest', 'nope']);
    out.headLocked = await named(engine, 'cursor_head_locked', ['k1']);
    out.headMissing = await named(engine, 'cursor_head_locked', ['nope']);
    out.intentHeld = [
      await named(engine, 'pending_intent_held', ['managed-sync', 'k1', JSON.stringify({ path: 'a.md', kind: 'managed_sync_import' })]),
      await named(engine, 'pending_intent_held', ['managed-sync', 'k1', JSON.stringify({ kind: 'other' })]),
      await named(engine, 'pending_intent_held', ['managed-sync', 'nope', '{}']),
    ];
    await writeCheckpointAt(engine, backend, 'managed-sync', 'k2', head({ runId: 'run-a', done: false }), '2026-01-01T00:00:00.000Z');
    out.finishedKept = await named(engine, 'finished_cursor_delete', ['k2']);
    out.finishedDeleted = await named(engine, 'finished_cursor_delete', ['k1']);
    out.manifestShared = await named(engine, 'manifest_delete_unshared', ['run-a']);
    out.manifestStillThere = (await named(engine, 'checkpoint_keys', ['managed-sync-manifest', 'run-a'])).length;
    await named(engine, 'checkpoint_delete', ['managed-sync', 'k2']);
    await writeCheckpointAt(engine, backend, 'managed-sync', 'k3', head({ done: true, runId: 'run-b' }), '2026-01-01T00:00:00.000Z');
    await named(engine, 'finished_cursor_delete', ['k3']);
    out.manifestFree = await named(engine, 'manifest_delete_unshared', ['run-a']);
    out.manifestGone = (await named(engine, 'checkpoint_keys', ['managed-sync-manifest', 'run-a'])).length;
    for (const fp of ['w:i:a', 'w:i:b', 'w:j:a']) await writeCheckpointAt(engine, backend, 'managed-sync-slice', fp, [{ target: 't' }], '2026-01-01T00:00:00.000Z');
    out.prefix = await named(engine, 'prefix_delete', ['managed-sync-slice', 'w:i:']);
    out.prefixLeft = (await named<{ fingerprint: string }>(engine, 'checkpoint_prefix', ['managed-sync-slice', 'w:'])).map(row => row.fingerprint);
    // A session setting reads back its value on SQL and nothing here (managed_sync_store.rs); no caller reads the row.
    await named(engine, 'waiver_settings');
    expect(out.manifestInsert).toEqual([]);
    expect((out.insert as unknown[]).length).toBe(1);
    expect(out.insertAgain).toEqual([]);
    expect(out.swapLost).toEqual([]);
    expect((out.swapWon as unknown[]).length).toBe(1);
    expect(out.finishedKept).toEqual([]);
    expect(out.manifestStillThere).toBe(1);
    expect(out.manifestGone).toBe(0);
    expect(out.prefixLeft).toEqual(['w:j:a']);
    return JSON.parse(JSON.stringify(out));
  });

  parityTest('request statements: unfinished page request, stale requests, open cursor requests, lock read, predecessor, state and refused checkpoint', {
    methods: ['runSyncStatement', 'insertWriteRequest', 'getWorktreeBinding'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, { 'notes/alice-example.md': note('Alice Example', 'Works at acme-example.') }, async (_root, _sync, incarnation) => {
    const binding = (await getWorktreeBinding(engine, 'work'))!;
    const worktree = binding.worktree_id;
    const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const params = (slug: string, pageId: number | null, path: string | null, origin: string | null) => [worktree, incarnation, 'work', slug, pageId, String(pageId), path, origin];
    const unfinished = async (...args: Parameters<typeof params>) => (await named(engine, 'unfinished_page_request', params(...args))).length;
    const before = { bySlug: await unfinished('notes/x', 11, 'notes/x.md', 'notes/x.md') };
    await seedWorktreeRequest(engine, binding, { slug: 'notes/x', requestId: U(1), state: 'queued', pageId: 11 });
    const open = {
      bySlug: await unfinished('notes/x', null, null, null),
      byPageId: await unfinished('notes/other', 11, null, null),
      byOtherPage: await unfinished('notes/other', 12, null, null),
    };
    await seedWorktreeRequest(engine, binding, { slug: 'notes/renamed', requestId: U(2), state: 'queued', intent: { path: 'notes/new.md', sourcePath: 'notes/new.md', renameFrom: { slug: 'notes/old', pageId: 30, sourcePath: 'notes/old.md' } } });
    const rename = {
      byOldSlug: await unfinished('notes/old', null, null, null),
      byOldPageId: await unfinished('notes/zzz', 30, null, null),
      byPath: await unfinished('notes/zzz', null, 'notes/new.md', 'nowhere.md'),
      byOrigin: await unfinished('notes/zzz', null, 'x.md', 'notes/new.md'),
      byRenameOrigin: await unfinished('notes/zzz', null, 'x.md', 'notes/old.md'),
      pathSkipped: await unfinished('notes/zzz', null, null, 'notes/new.md'),
    };
    // Failed requests of a run's index (the hold gate's stale receipts).
    for (const [n, state, intent] of [[3, 'failed', { runId: 'run-1', index: 2, kind: 'managed_sync_import' }], [4, 'cancelled', { runId: 'run-1', index: 2, kind: 'managed_sync_delete' }],
      [5, 'failed', { runId: 'run-1', index: 3, kind: 'managed_sync_import' }], [6, 'failed', { runId: 'run-2', index: 2, kind: 'managed_sync_import' }], [7, 'failed', { runId: 'run-1', index: 2, kind: 'other' }]] as const) {
      await seedWorktreeRequest(engine, binding, { slug: `notes/s${n}`, requestId: U(n), state: 'queued', intent });
      const row = (await named<{ id: string }>(engine, 'request_for_update', [(await seededId(engine, U(n)))]))[0]!;
      await settle(engine, row.id, state);
    }
    const label = (id: string) => `#${Number(id.slice(-12))}`;
    const stale = (await named<{ request_id: string }>(engine, 'stale_page_requests', [worktree, 'run-1', '2'])).map(r => label(r.request_id)).sort();
    // Cursor-keyed requests, open or with recovery.
    await seedWorktreeRequest(engine, binding, { slug: 'notes/k1', requestId: U(8), state: 'queued', intent: { cursorKey: 'ck' } });
    await seedWorktreeRequest(engine, binding, { slug: 'notes/k2', requestId: U(9), state: 'queued', intent: { cursorKey: 'ck' } });
    await seedWorktreeRequest(engine, binding, { slug: 'notes/k3', requestId: U(10), state: 'queued', intent: { cursorKey: 'other' } });
    const cursorOpen = (await named<{ request_id: string; state: string; slug: string; sequence: unknown }>(engine, 'cursor_open_requests', ['work', 'ck']))
      .map(r => ({ id: label(r.request_id), state: r.state, slug: r.slug }));
    const lockRow = (await named<{ request_id: string; state: string; created_at: unknown }>(engine, 'request_for_update', [await seededId(engine, U(8))]));
    const lock = lockRow.map(r => ({ id: label(r.request_id), state: r.state, dated: r.created_at instanceof Date }));
    const missing = await named(engine, 'request_for_update', [U(999)]);
    // Window predecessor reads.
    const seq = async (n: number) => Number((await named<{ sequence: string | number }>(engine, 'request_for_update', [await seededId(engine, U(n))]))[0]!.sequence);
    const predecessor = {
      group: (await named<{ state: string; request_id: string }>(engine, 'group_predecessor', ['local_cli', 'run-seed', await seq(9) + 0, 'g'])).length,
      state: (await named<{ state: string }>(engine, 'request_state_by_principal', ['local_cli', 'run-seed', U(1)])).map(r => r.state),
      stateMissing: (await named(engine, 'request_state_by_principal', ['local_cli', 'run-seed', U(998)])).length,
    };
    // The refused checkpoint: failed, then superseded by a later committed checkpoint, a removal and a same-digest retry.
    const checkpoint = { operation: 'submit_job', slug: '__managed_sync_checkpoint__', intent: { kind: 'managed_sync_checkpoint' } } as const;
    const refused = async () => (await named(engine, 'refused_checkpoint', ['work'])).length;
    const steps: Record<string, number> = { none: await refused() };
    const failedCheckpoint = await seedTypedRequest(engine, { source: 'work', ...checkpoint, state: 'failed', requestId: U(20), errorCode: 'source_changed' });
    steps.failed = await refused();
    await seedTypedRequest(engine, { source: 'work', ...checkpoint, state: 'failed', requestId: U(21), digest: 'other' });
    steps.laterFailedOtherDigest = await refused();
    await seedTypedRequest(engine, { source: 'work', operation: 'put_page', slug: '__managed_sync_checkpoint__', state: 'committed', requestId: U(22), digest: 'other' });
    steps.laterPutPageDoesNotSupersede = await refused();
    await seedTypedRequest(engine, { source: 'work', ...checkpoint, state: 'committed', requestId: U(23), digest: 'other' });
    steps.laterCommittedCheckpoint = await refused();
    expect(failedCheckpoint.requestId).toBe(U(20));
    const out = { before, open, rename, stale, cursorOpen, lock, missing: missing.length, predecessor, steps };
    expect(before.bySlug).toBe(0);
    expect(open).toEqual({ bySlug: 1, byPageId: 1, byOtherPage: 0 });
    expect(rename).toEqual({ byOldSlug: 1, byOldPageId: 1, byPath: 1, byOrigin: 1, byRenameOrigin: 1, pathSkipped: 0 });
    expect(stale).toEqual(['#3', '#4']);
    expect(steps).toEqual({ none: 0, failed: 1, laterFailedOtherDigest: 1, laterPutPageDoesNotSupersede: 1, laterCommittedCheckpoint: 0 });
    return JSON.parse(JSON.stringify(out));
  }));

  parityTest('page statements: the waiver pages and the kernel pages answer the live page rows', {
    methods: ['runSyncStatement', 'worktreeClaimStore', 'listPages'], timeout: 240_000,
  }, async (engine, backend) => withManagedSource(engine, backend, {
    'notes/alice-example.md': note('Alice Example', 'Works at acme-example.'), 'notes/bob-example.md': note('Bob Example', 'Works at widget-co.'),
  }, async (root, sync) => {
    expect((await sync()).status).toBe('first_sync');
    unlinkSync(join(root, 'notes', 'bob-example.md'));
    chmodSync(join(root, 'notes', 'alice-example.md'), 0o644);
    commit(root, 'delete bob');
    expect((await sync()).status).toBe('synced');
    const alice = (await engine.getPage('notes/alice-example', { sourceId: 'work' }))!;
    const strip = (rows: Array<Record<string, any>>): Array<Record<string, any>> => rows.map(row => ({ ...row, id: row.id === alice.id ? 'alice' : 'other', knowledge_revision: String(row.knowledge_revision) === String(alice.id) ? 'x' : typeof row.knowledge_revision }));
    const waiver = strip(await named(engine, 'waiver_pages', ['work', ['notes/alice-example', 'notes/bob-example', 'notes/none']]));
    const slugs = ['notes/alice-example', 'notes/bob-example'];
    const kernel = strip(await named(engine, 'kernel_pages_by_slug', ['work', slugs]));
    const kernelUnmanifested = strip(await named(engine, 'kernel_pages_by_slug_unmanifested', ['work', slugs]));
    const byId = strip(await named(engine, 'kernel_page_by_id', [alice.id]));
    const out = { waiver: waiver.map(row => ({ slug: row.slug, deleted: row.deleted })).sort((a, b) => String(a.slug).localeCompare(String(b.slug))),
      kernel: kernel.map(row => ({ slug: row.slug, chunker: row.chunker_version, sealed: row.text_projection_revision === row.knowledge_revision || typeof row.text_projection_revision, mode_pending: row.mode_pending, unembedded: row.unembedded, source_path: row.source_path })),
      sameWhenUnmanifested: JSON.stringify(kernelUnmanifested) === JSON.stringify(kernel), byId: byId.map(row => row.slug) };
    expect(out.waiver).toEqual([{ slug: 'notes/alice-example', deleted: false }, { slug: 'notes/bob-example', deleted: true }]);
    expect(out.kernel.map(row => row.slug)).toEqual(['notes/alice-example']);
    return out;
  }));
});

/** The row id of the request admitted under `requestId` (the typed members key a request by its row id). */
async function seededId(engine: BrainEngine, requestId: string): Promise<string> {
  const rows = await engine.readWriteRequestsByRequestId(requestId);
  return rows[0]!.id;
}

/** Settles a seeded request to a terminal `state`, as the typed fixture does. */
async function settle(engine: BrainEngine, id: string, state: 'failed' | 'cancelled' | 'committed'): Promise<void> {
  const { declarePersistenceProtocol } = await import('../../src/core/persistence/protocol.ts');
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.completeWriteRow({ id, state, outcome: null, errorCode: null, errorMessage: null, consumerVersion: 'v-run-seed', consumerHostId: null, errorDetail: null, resultBytes: 0,
      counterKeys: [], intentBytes: 0, retainedBytes: 0, terminalReservation: 0, probePurges: false } as never);
  });
}
