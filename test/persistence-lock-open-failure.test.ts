/**
 * #6305: a process that cannot open the worktree lock file leaves its write for an owner instead of failing it.
 *
 * Protects: an unopenable lock (a directory where the lock file belongs: EISDIR from the native addon; a file where its
 * directory belongs: EEXIST from mkdir) is a typed open failure carrying the OS error; `publishMutation` and, on Postgres,
 * the single-write group path (`publishSingleWrite` → `publishGroup`, the path PR #6310 missed) release the claim as
 * `queued` / `writer_lock_unavailable` with no page written, and an owner that can open the lock publishes the same request
 * later. Negative controls: an EISDIR on the brain path (the page's own file) still fails terminally with `storage_error`,
 * and an addon/close failure is not an open failure. `ownerExceptionFailure` reports the OS error, not the gbrain code.
 * Test idea from PR #6310 (@andreineacsu).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { acquireNativeLock, isLockOpenFailure, NativeLockUnavailableError, nativeLockOsError } from '../src/core/persistence/native-lock.ts';
import { ownerExceptionFailure } from '../src/core/persistence/publication-failure.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { lockOpenOsError } from '../src/core/persistence/native-lock.ts';
import { drainNext, runDrain } from '../src/core/persistence/sync-drain.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { publishSingleWrite } from '../src/core/persistence/group-publish.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const putPage = operations.find(o => o.name === 'put_page')!;
const page = (body: string) => `---\ntitle: Example\ntype: note\n---\n\n${body}\n`;

describe('native lock open failures are typed and carry the OS error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-lock-open-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  test('a directory at the lock path is EISDIR; a file where its directory belongs is EEXIST (mkdir); both are open failures', async () => {
    const asDir = join(dir, 'busy.lock'); mkdirSync(asDir);
    const eisdir = await acquireNativeLock(asDir, { timeoutMs: 0 }).catch((error: unknown) => error);
    expect(isLockOpenFailure(eisdir)).toBe(true);
    expect((eisdir as NativeLockUnavailableError).osError).toBe('EISDIR');
    expect((eisdir as Error).message).toContain('(EISDIR)');
    const parent = join(dir, 'file'); writeFileSync(parent, 'x');
    const enotdir = await acquireNativeLock(join(parent, 'w.lock'), { timeoutMs: 0 }).catch((error: unknown) => error);
    expect(isLockOpenFailure(enotdir)).toBe(true);
    expect((enotdir as NativeLockUnavailableError).osError).toBe('EEXIST');
  });
  test('other native lock failures are not open failures; the addon message maps to an errno name', () => {
    expect(isLockOpenFailure(new NativeLockUnavailableError('Cannot close the writer lock handle; this host must stop publishing'))).toBe(false);
    expect(isLockOpenFailure(Object.assign(new Error('Cannot open'), { code: 'writer_lock_unavailable' }))).toBe(false);
    expect(nativeLockOsError(new Error('Native lock open failed (OS error 13)'))).toBe(process.platform === 'win32' ? 'os_error_13' : 'EACCES');
    expect(nativeLockOsError(new Error('Native lock open failed (OS error 0)'))).toBeUndefined();
  });
  test('a managed drain whose head stays queued as writer_lock_unavailable stops drain_stalled with a next that names it', async () => {
    const pending = { status: 'partial', reason: 'writer_pending', fromCommit: null, toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [],
      managedCursor: { index: 1, total: 3 } } as SyncResult;
    const stall = { request_id: 'req-1', state: 'queued', blocked_reason: 'writer_lock_unavailable', head_request_id: 'req-1', head_state: 'queued', claimable_here: false, owner_is_this_host: true };
    const result = await runDrain({ pass: async () => pending, pauseMs: 1, stallMs: 20, probe: { blockedHead: async () => null, fingerprint: async () => ({ key: 'same', stall, claim: null }) } });
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'drain_stalled', stall: { blocked_reason: 'writer_lock_unavailable', cause: 'no_progress' } });
    const next = drainNext(result, 'gbrain sync --source default --no-pull', 'default')!;
    expect(next).toMatchObject({ command: 'gbrain sources writer status --source default --json', code: 'drain_stalled', safe_to_loop: false });
    expect(next.why).toContain('blocked_reason=writer_lock_unavailable');
    expect(next.why).toContain('names the OS error');
  });
  test('ownerExceptionFailure reports the OS error, not the gbrain code', () => {
    const error = new NativeLockUnavailableError('The OS could not acquire the writer lock', Object.assign(new Error('x'), { code: 'EACCES' }));
    expect(ownerExceptionFailure(error).detail).toMatchObject({ origin: 'owner_exception', errno: 'EACCES' });
  });
});

for (const kind of testBackends()) {
  describe(`a write this process cannot lock waits for an owner (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let root = '';
    const home = mkdtempSync(join(tmpdir(), 'gbrain-lock-open-home-'));
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine)); await close?.(); rmSync(home, { recursive: true, force: true }); });
    beforeEach(async () => {
      await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      if (kind === 'pglite') await resetPgliteState(engine as PGLiteEngine);
      _resetWriteThroughCacheForTest();
      if (kind === 'postgres' && root) return;
      root = mkdtempSync(join(home, 'brain-'));
      await engine.setConfig('sync.repo_path', root);
      if (kind === 'postgres') {
        // Postgres binds no worktree on first write; claim it once for this file (a second claim would need a transfer).
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, 'default', root));
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    });
    const context = (): OperationContext => ({ engine, config: { engine: kind, embedding_disabled: true } as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });

    /** Admits and claims one put_page of `slug` the way the resident consumer would, after a first write bound the worktree. */
    async function claimedPut(slug: string) {
      await putPage.handler(context(), { slug: `notes/bootstrap-${randomUUID().slice(0, 8)}`, content: page('Binds the worktree.'), request_id: randomUUID() });
      await disposePersistenceConsumer(engine);
      const binding = (await getWorktreeBinding(engine, 'default'))!;
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      const authority = await submissionAuthority(context(), 'put_page', 'default', source!.incarnation, slug);
      const intent = { content: page('Written by a process that cannot lock.') };
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: source!.incarnation,
        slug, pageId: null, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation, requestId: randomUUID(), callerIntent: intent, intent });
      const row = (await claimNextWrite(engine, localHostId()))!;
      return { row, binding, prepared: await preparePageMutation(engine, row, context().config) };
    }
    const publish = kind === 'postgres' ? publishSingleWrite : publishMutation;

    test('an unopenable lock leaves the write queued as writer_lock_unavailable; an owner that can lock publishes it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const { row, binding, prepared } = await claimedPut('notes/locked-out');
      rmSync(binding.coordination_path!, { force: true }); mkdirSync(binding.coordination_path!);
      const released = await publish(engine, row, prepared);
      expect(released).toMatchObject({ state: 'queued', blocked_reason: 'writer_lock_unavailable' });
      expect(await engine.getPage('notes/locked-out', { sourceId: 'default' })).toBeNull();
      rmSync(binding.coordination_path!, { recursive: true, force: true });
      const again = (await claimNextWrite(engine, localHostId()))!;
      expect(again.id).toBe(row.id);
      const committed = await publish(engine, again, await preparePageMutation(engine, again, context().config));
      expect(committed.state).toBe('committed');
      expect((await getWriteRequestById(engine, row.id))?.state).toBe('committed');
      expect(await engine.getPage('notes/locked-out', { sourceId: 'default' })).not.toBeNull();
    }), 120_000);

    test('the release keeps the OS error for the consumer log line (lockOpenOsError)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const { row, binding, prepared } = await claimedPut('notes/locked-out-errno');
      rmSync(binding.coordination_path!, { force: true }); mkdirSync(binding.coordination_path!);
      expect(await publish(engine, row, prepared)).toMatchObject({ state: 'queued', blocked_reason: 'writer_lock_unavailable' });
      expect(lockOpenOsError(binding.worktree_id)).toBe('EISDIR');
      rmSync(binding.coordination_path!, { recursive: true, force: true });
      const again = (await claimNextWrite(engine, localHostId()))!;
      expect((await publish(engine, again, await preparePageMutation(engine, again, context().config))).state).toBe('committed');
    }), 120_000);

    test('an EISDIR on the page file itself (the brain path) still fails terminally', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const { row, prepared } = await claimedPut('notes/blocked-file');
      mkdirSync(join(root, 'notes', 'blocked-file.md'), { recursive: true });
      const failed = await publish(engine, row, prepared);
      expect(failed).toMatchObject({ state: 'failed', error_code: 'storage_error' });
    }), 120_000);
  });
}
