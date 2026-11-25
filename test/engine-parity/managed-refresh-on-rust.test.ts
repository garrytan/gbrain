/**
 * Engine parity: a managed checkout's refresh, the writes that wait behind it, and grouped admission on a Rust brain,
 * with the user-facing hold kept (lane LM, slice 2, refresh part).
 *
 * Every case lifts the `managed_persistence` hold on its own Rust test engine (rust-managed.ts `liftManagedHold`), so the
 * ordinary Rust arm runs the managed path for real; `servedCapabilities()` still withholds the capability, so a user's
 * Rust brain keeps refusing. Each case returns its answers and the arms must agree.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a claimed and activated checkout with an upstream, `gbrain sources refresh` fences the worktree, merges
 *    the new upstream commit, and completes (or resumes after an interruption) with the same refresh states, HEAD and member
 *    answers; a page write admitted while the refresh holds the worktree is answered pending, waits behind the barrier, and
 *    commits after the refresh is released; a write whose file holds a committed change that managed sync has not imported
 *    waits for that import, is counted as held behind it, and expires `pending_import_expired` once the hold outlasts its
 *    limit; a grouped admission (put_pages) of several bound writes publishes them together in one commit.
 *  - Regression: an engine that refuses a step (the refresh writer's rows, the claim stamp's refresh barrier, the import
 *    hold, the group claim) or answers it differently from PGLite and Postgres.
 *  - Why existing coverage misses it: the refresh and barrier tests (refresh-write-barrier.test.ts and others) read their
 *    rows through `executeRaw`, which the Rust engine does not have, and the managed parity files stop at the hold.
 *  - Seam: the refresh state machine's boundary hooks (`hooks.boundary`); real engines, real Git checkouts and a local
 *    bare upstream.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { hostIdFor, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { importManagedFiles } from '../../src/core/persistence/import-mutations.ts';
import { activeWorktreeRefreshes, refreshWorktree } from '../../src/core/persistence/worktree-refresh.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { _resetRefreshBarrierCacheForTests, expireDeferredWrites, REFRESH_BARRIER_MAX_WAIT_KEY } from '../../src/core/persistence/refresh-barrier.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...GIT_ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;

function commitFile(root: string, path: string, content: string): string {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, 'add', '--', path);
  git(root, 'commit', '-qm', `update ${path}`);
  return git(root, 'rev-parse', 'HEAD');
}

interface Checkout { home: string; root: string; remote: string; upstream: string; push: (path: string, content: string) => string; head: () => string }

/**
 * Lifts the hold on the Rust arm's engine, then runs `run` under a scratch GBRAIN_HOME with source `work` registered on a
 * clone of a local bare upstream (one committed note) and claimed and activated (`gbrain sources writer claim`, `activate`),
 * with the refresh write barrier on.
 */
async function withRefreshCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (checkout: Checkout) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-refresh-on-rust-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REFRESH_BARRIER: '1' }, async () => {
      resetWriteSwitches();
      _resetRefreshBarrierCacheForTests();
      const remote = join(home, 'origin.git'), upstream = join(home, 'upstream'), root = join(home, 'checkout');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      execFileSync('git', ['clone', '-q', remote, upstream], { stdio: 'ignore' });
      git(upstream, 'checkout', '-q', '-b', 'main');
      commitFile(upstream, 'notes/alice-example.md', page('Alice Example', 'Works at acme-example.'));
      git(upstream, 'push', '-q', 'origin', 'main');
      execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
      await createSource(engine, backend, 'work', { remote_url: remote }, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      const checkout: Checkout = { home, root, remote, upstream, head: () => git(root, 'rev-parse', 'HEAD'),
        push: (path, content) => { const sha = commitFile(upstream, path, content); git(upstream, 'push', '-q', 'origin', 'main'); return sha; } };
      try { return await run(checkout); } finally { await disposePersistenceConsumer(engine); resetWriteSwitches(); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const ctxFor = (engine: BrainEngine, sourceId = 'work') => ({ engine, sourceId, remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

const put = (engine: BrainEngine, slug: string, title: string, request_id = randomUUID(), extra: Record<string, unknown> = {}) =>
  submitPageMutation(ctxFor(engine) as never, { operation: 'put_page', params: { slug, content: page(title, 'Works at widget-co.'), request_id, ...extra } });

const stateOf = async (engine: BrainEngine, request_id: string) =>
  (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id))?.state ?? null;

/** Runs `during` while a real refresh of the checkout (upstream has one new commit) is paused at its drained boundary. */
async function duringRefresh<T>(engine: BrainEngine, checkout: Checkout, during: () => Promise<T>) {
  const target = checkout.push('notes/bob-example.md', page('Bob Example', 'Upstream observation.'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const drained = new Promise<void>(resolve => { reached = resolve; });
  const refresh = refreshWorktree(engine, 'work', { syncBudgetMs: 0, hooks: { boundary: async point => { if (point === 'drained') { reached(); await gate; } } } });
  refresh.catch(() => undefined);
  await Promise.race([drained, refresh]);
  let value: T;
  try { value = await during(); } catch (error) { release(); await refresh.catch(() => undefined); throw error; }
  release();
  return { value, result: await refresh, target };
}

describe('managed refresh and grouped admission on a Rust brain, hold kept for users', () => {
  parityTest('a refresh after a new upstream commit fences, merges the checkout and completes', {
    methods: ['getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withRefreshCheckout(engine, backend, async checkout => {
    const before = checkout.head();
    const target = checkout.push('notes/bob-example.md', page('Bob Example', 'Upstream observation.'));
    const dry = await refreshWorktree(engine, 'work', { dryRun: true });
    const result = await refreshWorktree(engine, 'work', { syncBudgetMs: 0 });
    const again = await refreshWorktree(engine, 'work', { syncBudgetMs: 0 });
    const out = {
      dry: { status: dry.status, behind: dry.old_head === before && dry.target_head === target },
      status: result.status, merged: result.old_head === before && result.target_head === target, upstream: result.upstream_ref,
      synced: result.synced.map(member => ({ source_id: member.source_id, status: member.status })),
      head: checkout.head() === target, file: existsSync(join(checkout.root, 'notes', 'bob-example.md')),
      timed: result.refresh_id ? (await engine.readRefreshTiming(result.refresh_id)) !== null : null,
      active: (await activeWorktreeRefreshes(engine, 'work')).length,
      again: { status: again.status, refresh_id: again.refresh_id },
    };
    expect(out).toMatchObject({ dry: { status: 'dry_run', behind: true }, status: 'sync_deferred', merged: true, head: true, file: true, timed: true, active: 0,
      again: { refresh_id: null } });
    return out;
  }));

  parityTest('a refresh interrupted after its merge is resumed and completed', {
    methods: ['getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withRefreshCheckout(engine, backend, async checkout => {
    const target = checkout.push('notes/bob-example.md', page('Bob Example', 'Upstream observation.'));
    let code: string | undefined;
    try {
      await refreshWorktree(engine, 'work', { syncBudgetMs: 0, hooks: { boundary: point => {
        if (point === 'syncing') throw new OperationError('storage_error', 'Injected stop after the merge.', 'Test fault.');
      } } });
    } catch (e) { code = (e as { code?: string }).code; }
    const stopped = (await activeWorktreeRefreshes(engine, 'work')).map(row => row.state);
    const resumed = await refreshWorktree(engine, 'work', { resume: true, syncBudgetMs: 0 });
    const nothing = await refreshWorktree(engine, 'work', { resume: true, syncBudgetMs: 0 });
    const out = { code, stopped, head: checkout.head() === target, resumed: { status: resumed.status, recovered: resumed.recovered?.state ?? null,
      synced: resumed.synced.map(member => member.status) }, after: (await activeWorktreeRefreshes(engine, 'work')).length, nothing: nothing.status };
    expect(out).toMatchObject({ code: 'storage_error', stopped: ['syncing'], head: true, after: 0, nothing: 'nothing_to_resume' });
    return out;
  }));

  parityTest('a page write admitted during a refresh waits behind the barrier and commits after it', {
    methods: ['getWorktreeBinding', 'getPage'],
    timeout: 180_000,
  }, async (engine, backend) => withRefreshCheckout(engine, backend, async checkout => {
    const request_id = randomUUID();
    const during = await duringRefresh(engine, checkout, async () => {
      // A write that waits is answered pending: the call ends on write_pending with the queued receipt.
      const answer = await put(engine, 'notes/carol-example', 'Carol Example', request_id, { wait_ms: 0 }).then(() => 'accepted', (e: { code?: string }) => e?.code ?? String(e));
      return { answer,
        state: await stateOf(engine, request_id), active: (await activeWorktreeRefreshes(engine, 'work')).map(row => row.state),
        pageDuring: (await engine.getPage('notes/carol-example', { sourceId: 'work' }))?.title ?? null };
    });
    const row = (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id))!;
    const done = await waitForWrite(engine, row, { engine: engine.kind } as never, 30_000);
    const out = { during: during.value, refresh: during.result.status, final: done.state,
      page: (await engine.getPage('notes/carol-example', { sourceId: 'work' }))?.title ?? null,
      file: existsSync(join(checkout.root, 'notes', 'carol-example.md')), head: checkout.head() !== during.target ? 'moved-on' : 'at-target' };
    expect(out).toMatchObject({ during: { answer: 'write_pending', state: 'deferred', pageDuring: null }, refresh: 'sync_deferred', final: 'committed', page: 'Carol Example', file: true });
    return out;
  }));

  parityTest('a write behind a held import is counted and held, and expires when the import never lands', {
    methods: ['getWorktreeBinding', 'countHeldBehindImport'],
    timeout: 180_000,
  }, async (engine, backend) => withRefreshCheckout(engine, backend, async checkout => {
    // A page whose file another agent then changed and committed through Git: managed sync has not imported that commit
    // (the source has no last_commit), so a write to the page waits for the import instead of overwriting it.
    await put(engine, 'notes/gina-example', 'Gina Example', randomUUID(), { wait_ms: 30_000 });
    commitFile(checkout.root, 'notes/gina-example.md', page('Gina Example', 'Edited through Git by another agent.'));
    const request_id = randomUUID();
    const answer = await put(engine, 'notes/gina-example', 'Gina Rewritten', request_id, { wait_ms: 0, force: true }).then(() => 'accepted', (e: { code?: string }) => e?.code ?? String(e));
    let state = await stateOf(engine, request_id);
    for (let i = 0; i < 100 && state !== 'deferred'; i++) { await Bun.sleep(100); state = await stateOf(engine, request_id); }
    const held = await engine.countHeldBehindImport('work', null);
    const heldByPrincipal = await engine.countHeldBehindImport('work', { kind: 'local_cli', id: (await readLocalWriter(engine, 'cli')).id });
    const elsewhere = await engine.countHeldBehindImport('other', null);
    // The hold outlasts its limit: the owner ends the write failed, nothing applied.
    await engine.setConfig(REFRESH_BARRIER_MAX_WAIT_KEY, '1');
    await Bun.sleep(50);
    let final = state;
    for (let i = 0; i < 100 && final === 'deferred'; i++) {
      await expireDeferredWrites(engine, hostIdFor(engine));
      await Bun.sleep(100);
      final = await stateOf(engine, request_id);
    }
    const row = await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
    const out = { answer, state, held: { count: held.count, bytes: held.bytes > 0 }, heldByPrincipal: heldByPrincipal.count, elsewhere: elsewhere.count,
      final, error: row?.error_code ?? null, afterExpiry: (await engine.countHeldBehindImport('work', null)).count,
      page: (await engine.getPage('notes/gina-example', { sourceId: 'work' }))?.title ?? null };
    expect(out).toMatchObject({ state: 'deferred', held: { count: 1, bytes: true }, heldByPrincipal: 1, elsewhere: 0, final: 'failed', error: 'pending_import_expired', afterExpiry: 0, page: 'Gina Example' });
    return out;
  }));

  parityTest('a grouped admission of several bound writes publishes them together', {
    methods: ['getWorktreeBinding', 'getPage'],
    timeout: 180_000,
  }, async (engine, backend) => withRefreshCheckout(engine, backend, async checkout => {
    const { operationsByName } = await import('../../src/core/operations.ts');
    const slugs = ['notes/dora-example', 'notes/evan-example', 'notes/fay-example'];
    // put_pages: one transaction admits every page (admitWriteGroupInTransaction) with each page's own receipt.
    const receipt = await operationsByName.put_pages!.handler(ctxFor(engine) as never, { request_id: randomUUID(), wait_ms: 30_000,
      pages: slugs.map(slug => ({ slug, content: page(slug.split('/')[1]!, 'Works at widget-co.') })) }) as Record<string, any>;
    // A managed import of files already in the checkout: one admission marked with an import batch, which the owner claims
    // and publishes as a group (claimGroupFollowers, markDispatched, renewGroupClaims).
    const files = ['notes/gus-example', 'notes/hope-example', 'notes/ivan-example'];
    for (const slug of files) writeFileSync(join(checkout.root, `${slug}.md`), page(slug.split('/')[1]!, 'Works at widget-co.'));
    const settled = await importManagedFiles(engine, files.map(slug => ({ filePath: join(checkout.root, `${slug}.md`), sourcePath: `${slug}.md` })),
      { sourceId: 'work', noEmbed: true });
    const all = [...slugs, ...files];
    const titles = await Promise.all(all.map(async slug => (await engine.getPage(slug, { sourceId: 'work' }))?.title ?? null));
    const out = { put_pages: { state: receipt.state, counts: receipt.counts, pages: (receipt.pages as Array<{ slug: string; state: string }>).map(entry => `${entry.slug}:${entry.state}`) },
      import: settled.map(result => result.status === 'fulfilled' ? (result.value as { status?: string }).status ?? 'ok' : `rejected:${(result.reason as { code?: string })?.code}`),
      titles, files: all.map(slug => existsSync(join(checkout.root, `${slug}.md`))) };
    expect(out).toMatchObject({ put_pages: { state: 'committed', counts: { total: 3, committed: 3, pending: 0, failed: 0 } }, files: [true, true, true, true, true, true] });
    expect(out.titles.every(title => title !== null)).toBe(true);
    return out;
  }));
});
