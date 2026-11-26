/**
 * Engine parity: managed mode on a Rust brain (lane LM, slices 1 and 2).
 *
 * A single-host Rust engine serves `managed_persistence` (slice 2 lifted the hold; managed mode on a multi-user store waits for the multi-user branch),
 * so the ordinary Rust arm runs the managed path for real. `liftManagedHold` stays in the cases and changes nothing on such
 * an engine. Each case returns its answers and the arms must agree.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a claimed checkout, a put_page to the bound source commits the page and writes its file; a refusal at
 *    publication ends the request failed with no page and no file; source lifecycle changes of a managed brain (add,
 *    archive, restore, set-path, remove) commit under topology locks with the same receipts and rows; a moved checkout
 *    is found with its members; add_link and remove_link on a managed page rewrite its links fence.
 *  - Regression: an engine that refuses a step of managed mode (worktree admission, ownership, compareFileTarget,
 *    publication recovery, topology locks, the moved-checkout read, the managed link rewrite), or answers it
 *    differently from PGLite.
 *  - Why existing coverage misses it: the managed parity files declare `requires: 'managed_persistence'`, so on the
 *    ordinary Rust arm they count the hold's refusal as stopped and never run the managed members.
 *  - Secret publish maintenance (git/redact-finish.ts) reads the host bindings and the failed Git effects of managed mode
 *    through gitDurabilityStore, and only where managed mode is served: no managed-table read refuses and is swallowed.
 *  - Seam: the publication fault hook (persistence/fault-points.ts); real engines, real Git checkouts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { hostIdFor, localHostId, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { movedPhysicalRoot } from '../../src/core/persistence/physical-root.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { secretPublishMaintenance } from '../../src/core/git/redact-finish.ts';
import { isEngineCapabilityRefusal } from '../../src/core/engine-capability-refusal.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];

/** A Git checkout at `root` with one committed note. */
function gitCheckout(root: string, note: string, body: string): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'notes', note), body);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, ...GIT_ID, 'commit', '-qm', 'notes']);
}

/**
 * Lifts the hold on the Rust arm's engine, then runs `run` under a scratch GBRAIN_HOME with source `work` registered on a
 * one-note Git checkout and claimed (`gbrain sources writer claim`); `activate` also turns managed mode on.
 */
async function withManagedCheckout<T>(engine: BrainEngine, backend: ParityBackend, opts: { activate?: boolean; durable?: boolean },
  run: (home: string, root: string) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-on-rust-')));
  try {
    // GBRAIN_GIT_ALLOW_FILE_TRANSPORT: the durable cases push to a local bare remote.
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      const root = join(home, 'checkout');
      gitCheckout(root, 'alice-example.md', '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      await createSource(engine, backend, 'work', {}, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      if (opts.activate) await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      if (opts.durable) {
        // A local bare remote the push probe and the Git effect's push reach without the network.
        const remote = join(home, 'remote.git');
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
        execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
        execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main']);
        await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'work', enable: true, ...await reviewed('writer_git_durability') });
      }
      try { return await run(home, root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const ctxFor = (engine: BrainEngine, sourceId = 'work') => ({ engine, sourceId, remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

/** A lifecycle receipt with its fresh ids blanked and its scratch home written `<home>`, so the arms compare. */
const receipt = (out: unknown, home: string) => {
  const r = out as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return r;
  const { request_id: _r, source_incarnation: _i, ...rest } = r;
  return JSON.parse(JSON.stringify({ ...rest, ...(typeof r.request_id === 'string' ? { request_id: 'set' } : {}) }).split(home).join('<home>'));
};
/**
 * A put_page to `sourceId`, then bounded effect passes until each of its effects settles, so a lifecycle step that
 * follows never meets a write still publishing (that meeting is a race the lifecycle refuses on, not what these cases test).
 */
async function putSettled(engine: BrainEngine, sourceId: string, slug: string, title: string): Promise<void> {
  const request_id = randomUUID();
  await submitPageMutation(ctxFor(engine, sourceId) as never, { operation: 'put_page',
    params: { slug, content: `---\ntype: note\ntitle: ${title}\n---\nWorks at widget-co.\n`, request_id } });
  const row = await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
  for (let i = 0; i < 100; i++) {
    const open = row ? (await engine.readRequestEffects(row.id)).some(e => e.state === 'queued' || e.state === 'running') : false;
    if (!open) return;
    await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
    await Bun.sleep(50);
  }
  throw new Error(`the effects of ${slug} did not settle`);
}

const codeOf = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string }) => e?.code ?? String(e));

describe('managed mode on a Rust brain', () => {
  parityTest('managed mode is served on a single-host Rust brain', {
    methods: ['getConfig'],
  }, async (engine) => {
    await engine.getConfig('managed_on_rust_probe');
    const out = { served: servedCapabilities().has('managed_persistence') };
    expect(out).toEqual({ served: true });
    return out;
  });

  parityTest('claim the checkout, put_page to the bound source: the page and its file are written', {
    methods: ['worktreeClaimStore', 'getPage'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async (_home, root) => {
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/bob-example', content: '---\ntype: note\ntitle: Bob Example\n---\nWorks at widget-co.\n', request_id: randomUUID() } });
    const page = await engine.getPage('notes/bob-example', { sourceId: 'work' });
    const file = join(root, 'notes', 'bob-example.md');
    const out = { title: page?.title ?? null, file: existsSync(file) ? readFileSync(file, 'utf8').includes('Works at widget-co.') : false };
    expect(out).toEqual({ title: 'Bob Example', file: true });
    return out;
  }));

  parityTest('the Git effects of two bound writes commit and push the checkout', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'claimCoalescedGitEffects'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { durable: true }, async (home, root) => {
    const ids = [randomUUID(), randomUUID()];
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/gina-example', content: '---\ntype: note\ntitle: Gina Example\n---\nWorks at widget-co.\n', request_id: ids[0] } });
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
      params: { slug: 'notes/hank-example', content: '---\ntype: note\ntitle: Hank Example\n---\nWorks at widget-co.\n', request_id: ids[1] } });
    const writer = (await readLocalWriter(engine, 'cli')).id;
    const gitStates = async () => Promise.all(ids.map(async id => {
      const row = await engine.readWriteRequest('local_cli', writer, id);
      return row ? (await engine.readRequestEffects(row.id, 'git'))[0]?.state ?? 'none' : 'no request';
    }));
    // The consumer may already have run them, and an effect waits (publication_pending) until its write is published;
    // bounded passes settle whatever is left.
    for (let i = 0; i < 100 && (await gitStates()).some(state => state === 'queued' || state === 'running'); i++) {
      await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
      await Bun.sleep(100);
    }
    // A direct claim on the worktree now finds nothing left to coalesce.
    const worktree = (await engine.getWorktreeBinding('work', hostIdFor(engine)))!.worktree_id;
    const left = await engine.claimCoalescedGitEffects({ hostId: hostIdFor(engine), worktreeId: worktree, limit: 5, deadOwners: [], ownerJson: '{}' });
    const tracked = execFileSync('git', ['-C', root, 'ls-files', 'notes'], { encoding: 'utf8' }).trim().split('\n').sort();
    const pushed = execFileSync('git', ['-C', join(home, 'remote.git'), 'ls-tree', '-r', '--name-only', 'main', 'notes'], { encoding: 'utf8' }).trim().split('\n').sort();
    const out = { git: await gitStates(), tracked, pushed, left: left.length };
    const all = ['notes/alice-example.md', 'notes/gina-example.md', 'notes/hank-example.md'];
    expect(out).toEqual({ git: ['committed', 'committed'], tracked: all, pushed: all, left: 0 });
    return out;
  }));

  parityTest('a coalesced Git claim takes only ready single-file effects of its worktree, oldest first, up to its limit, once', {
    methods: ['worktreeClaimStore', 'insertWriteRequest', 'insertPublicationEffects', 'claimCoalescedGitEffects'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async () => {
    const host = hostIdFor(engine);
    const binding = (await engine.getWorktreeBinding('work', host))!;
    const source = (await engine.readSourceMembership('work'))!;
    const KEYS = ['brain'];
    // One journal row per effect batch; the consumer is never started, so nothing else claims them.
    const request = async (n: number) => {
      await engine.lockPersistenceCounters(KEYS);
      const { id } = await engine.insertWriteRequest({ principalKind: 'local_cli', principalId: 'parity-writer', requestId: `d0000000-0000-4000-8000-00000000000${n}`,
        operation: 'put_page', sourceId: 'work', sourceIncarnation: source.incarnation, pageId: null, slug: `notes/n${n}`, worktreeId: binding.worktree_id,
        topologyGeneration: null, digest: String(n).repeat(64), intent: { kind: 'put_page' }, authority: { scopes: ['write'] }, intentBytes: 10,
        terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: host, counterKeys: KEYS,
        clientRequestId: null, state: 'queued', deferredRefreshId: null });
      return id;
    };
    const effect = (path: string, extra: Record<string, unknown> = {}) => ({ kind: 'git', data: { relative_path: path, slug: path.replace(/\.md$/, ''), ...extra } });
    const seeded = [] as string[];
    for (const [n, effects] of [[1, [effect('notes/a.md')]], [2, [effect('notes/b.md')]], [3, [effect('notes/c.md', { source_scan: true })]],
      [4, [effect('notes/d.md', { version: 2 })]], [5, [effect('notes/e.md')]]] as const) {
      seeded.push(...await engine.insertPublicationEffects({ requestId: await request(n), revision: null, sourceId: 'work', sourceIncarnation: source.incarnation,
        worktreeId: binding.worktree_id, effects }));
    }
    const owner = JSON.stringify({ pid: 1, nonce: 'parity', start: 'parity' });
    const shape = (rows: Record<string, unknown>[]) => rows.map(row => ({ path: (row.data as { relative_path: string }).relative_path, state: row.state,
      attempts: Number(row.attempts), token: typeof row.execution_token === 'string', owner: (row.claim_owner as { owner?: unknown } | null)?.owner ?? null,
      stamped: (row.claim_owner as { token?: unknown } | null)?.token === row.execution_token, lease: row.claim_expires_at != null }))
      .sort((a, b) => a.path < b.path ? -1 : 1);
    const first = await engine.claimCoalescedGitEffects<Record<string, unknown>>({ hostId: host, worktreeId: binding.worktree_id, limit: 2, deadOwners: [], ownerJson: owner });
    const second = await engine.claimCoalescedGitEffects<Record<string, unknown>>({ hostId: host, worktreeId: binding.worktree_id, limit: 5, deadOwners: [], ownerJson: owner });
    const third = await engine.claimCoalescedGitEffects<Record<string, unknown>>({ hostId: host, worktreeId: binding.worktree_id, limit: 5, deadOwners: [], ownerJson: owner });
    const otherHost = await engine.claimCoalescedGitEffects<Record<string, unknown>>({ hostId: 'e0000000-0000-4000-8000-0000000000e9', worktreeId: binding.worktree_id,
      limit: 5, deadOwners: [], ownerJson: owner });
    const tokens = [...first, ...second].map(row => row.execution_token);
    const out = { seeded: seeded.length, first: shape(first), second: shape(second), third: third.length, otherHost: otherHost.length,
      distinctTokens: new Set(tokens).size === tokens.length };
    const claimed = (path: string) => ({ path, state: 'running', attempts: 1, token: true, owner: { pid: 1, nonce: 'parity', start: 'parity' }, stamped: true, lease: true });
    expect(out).toEqual({ seeded: 5, first: [claimed('notes/a.md'), claimed('notes/b.md')], second: [claimed('notes/e.md')], third: 0, otherHost: 0, distinctTokens: true });
    return out;
  }));

  parityTest('a lifecycle change waits for a publication in flight on its worktree: write_pending, nothing changed', {
    methods: ['worktreeClaimStore', 'insertWriteRequest', 'stampWriteClaim', 'readSourceMembership'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async () => {
    const host = hostIdFor(engine);
    const binding = (await engine.getWorktreeBinding('work', host))!;
    const source = (await engine.readSourceMembership('work'))!;
    await engine.lockPersistenceCounters(['brain']);
    const { id: inFlight } = await engine.insertWriteRequest({ principalKind: 'local_cli', principalId: 'parity-writer', requestId: 'd0000000-0000-4000-8000-0000000000f1',
      operation: 'put_page', sourceId: 'work', sourceIncarnation: source.incarnation, pageId: null, slug: 'notes/in-flight', worktreeId: binding.worktree_id,
      topologyGeneration: null, digest: 'f'.repeat(64), intent: { kind: 'put_page' }, authority: { scopes: ['write'] }, intentBytes: 10,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: host, counterKeys: ['brain'],
      clientRequestId: null, state: 'queued', deferredRefreshId: null });
    // A claimed request is a publication in flight (running under a live claim).
    expect((await engine.stampWriteClaim(inFlight, 'c0000000-0000-4000-8000-0000000000c9', 60_000, JSON.stringify({ phase: 'parity' })))?.state).toBe('running');
    const archive = await codeOf(() => runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'work' }));
    const after = await engine.readSourceMembership('work');
    const out = { archive, archived: after?.archived ?? null, incarnation: after?.incarnation === source.incarnation };
    expect(out).toEqual({ archive: 'write_pending', archived: false, incarnation: true });
    return out;
  }));

  parityTest('a refusal at publication ends the bound write failed through recovery: no page, no file', {
    methods: ['worktreeClaimStore', 'readWriteRequest', 'getPage'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async (_home, root) => {
    const request_id = randomUUID();
    const stored = async () => engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id);
    const seen: FaultPoint[] = [];
    installFaultHook(async (point) => {
      seen.push(point);
      if (point === 'publication:before_publication') throw new OperationError('storage_error', 'Injected refusal at publication.', 'Test fault.');
    });
    let code: string | undefined;
    try {
      await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
        params: { slug: 'notes/carol-example', content: '---\ntype: note\ntitle: Carol Example\n---\nWorks at widget-co.\n', request_id } });
    } catch (e) { code = (e as { code?: string }).code; } finally { installFaultHook(undefined); }
    const final = await stored();
    const out = { code, recovered: seen.includes('publication_recovery:before_clear'),
      final: final && { state: final.state, error_code: final.error_code, recovery: final.recovery != null },
      page: (await engine.getPage('notes/carol-example', { sourceId: 'work' }))?.title ?? null,
      file: existsSync(join(root, 'notes', 'carol-example.md')) };
    expect(out).toEqual({ code: 'storage_error', recovered: true, final: { state: 'failed', error_code: 'storage_error', recovery: false }, page: null, file: false });
    return out;
  }));

  parityTest('a managed brain adds, archives, restores and removes a source in its own checkout under topology locks', {
    methods: ['worktreeClaimStore', 'readSourceMembership', 'readTopologyChange', 'topologyStore'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async (home) => {
    const second = join(home, 'second');
    gitCheckout(second, 'dana-example.md', '---\ntitle: Dana Example\n---\nWorks at widget-co.\n');
    const steps: unknown[] = [];
    const step = async (input: Parameters<typeof runManagedSourceLifecycle>[1]) => {
      try { steps.push(receipt(await runManagedSourceLifecycle(engine, input), home)); }
      catch (e) { if ((e as { code?: string }).code === 'engine_capability_missing') throw e; steps.push({ refused: (e as { code?: string }).code }); }
      const member = await engine.readSourceMembership('second');
      steps.push({ registered: member !== null, archived: member?.archived ?? null });
    };
    await step({ operation: 'add', sourceId: 'second', path: second });
    // A page in the new source, so the remove deletes pages in its batches and with the incarnation.
    await putSettled(engine, 'second', 'notes/ivy-example', 'Ivy Example');
    steps.push({ page: (await engine.getPage('notes/ivy-example', { sourceId: 'second' }))?.title ?? null });
    await step({ operation: 'archive', sourceId: 'second' });
    await step({ operation: 'restore', sourceId: 'second' });
    await step({ operation: 'remove', sourceId: 'second', confirmDestructive: true });
    steps.push({ pageAfterRemove: (await engine.getPage('notes/ivy-example', { sourceId: 'second' }))?.title ?? null });
    // Purge follows an archive; the source and its page go, its files stay on disk.
    const third = join(home, 'third');
    gitCheckout(third, 'jade-example.md', '---\ntitle: Jade Example\n---\nWorks at acme-example.\n');
    await step({ operation: 'add', sourceId: 'second', path: third });
    await putSettled(engine, 'second', 'notes/kim-example', 'Kim Example');
    await step({ operation: 'purge', sourceId: 'second', confirmDestructive: true });
    await step({ operation: 'archive', sourceId: 'second' });
    await step({ operation: 'purge', sourceId: 'second', confirmDestructive: true });
    steps.push({ purged: (await engine.getPage('notes/kim-example', { sourceId: 'second' })) === null, filesKept: existsSync(join(third, 'notes', 'kim-example.md')) });
    // What every engine must do, so equal arms cannot all be wrong together.
    const states = steps.map(step => (step as { state?: string; refused?: string; operation?: string }))
      .filter(step => step.state || step.refused).map(step => step.refused ?? `${step.operation}:${step.state}`);
    expect(states).toEqual(['add:committed', 'archive:committed', 'restore:committed', 'remove:committed', 'add:committed', 'invalid_params',
      'archive:committed', 'purge:committed']);
    expect(steps.slice(-1)).toEqual([{ purged: true, filesKept: true }]);
    return steps;
  }));

  parityTest('set-path moves a source to the checkout where it now lives', {
    methods: ['worktreeClaimStore', 'getWorktreeBinding'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async (home, root) => {
    const moved = join(home, 'moved-checkout');
    renameSync(root, moved);
    const out: Record<string, unknown> = {};
    try { out.rebind = receipt(await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'work', path: moved }), home); }
    catch (e) { if ((e as { code?: string }).code === 'engine_capability_missing') throw e; out.rebind = { refused: (e as { code?: string }).code }; }
    const binding = await engine.getWorktreeBinding('work', localHostId());
    out.bound = binding ? { local: binding.local_path === moved, relative: binding.relative_path } : null;
    return out;
  }));

  parityTest('a moved checkout is found with its members', {
    methods: ['worktreeClaimStore'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async (home, root) => {
    const moved = join(home, 'moved-root');
    renameSync(root, moved);
    const found = await movedPhysicalRoot(engine as never, moved, localHostId());
    return { found: found ? found.members.map(member => member.sourceId) : null };
  }));

  parityTest('add_link and remove_link on a managed page rewrite its links fence', {
    methods: ['worktreeClaimStore', 'getPage', 'getLinks'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, { activate: true }, async (_home, root) => {
    const { operationsByName } = await import('../../src/core/operations.ts');
    const call = async (name: string, params: Record<string, unknown>) => {
      try { await operationsByName[name]!.handler(ctxFor(engine) as never, params); return 'ok'; }
      catch (e) { if ((e as { code?: string }).code === 'engine_capability_missing') throw e; return (e as { code?: string }).code ?? 'error'; }
    };
    const put = (slug: string, title: string) => call('put_page', { slug, content: `---\ntype: note\ntitle: ${title}\n---\nSynthetic note.\n` });
    const steps = [await put('notes/erin-example', 'Erin Example'), await put('notes/frank-example', 'Frank Example')];
    steps.push(await call('add_link', { from: 'notes/erin-example', to: 'notes/frank-example', link_type: 'mentions', context: 'Synthetic' }));
    const fenced = () => readFileSync(join(root, 'notes', 'erin-example.md'), 'utf8').includes('frank-example');
    const linked = async () => (await engine.getLinks('notes/erin-example', { sourceId: 'work' })).map(l => l.to_slug);
    const afterAdd = { file: fenced(), links: await linked() };
    steps.push(await call('remove_link', { from: 'notes/erin-example', to: 'notes/frank-example', link_type: 'mentions' }));
    const out = { steps, afterAdd, afterRemove: { file: fenced(), links: await linked() } };
    expect(out).toEqual({ steps: ['ok', 'ok', 'ok', 'ok'], afterAdd: { file: true, links: ['notes/frank-example'] }, afterRemove: { file: false, links: [] } });
    return out;
  }));

  /**
   * Runs secret publish maintenance with `engine.executeRaw` watched: the managed-mode statements (host bindings,
   * persistence effects) it sent that refused with a capability refusal, and the parked-push count it reported.
   */
  async function maintenanceRefusals(engine: BrainEngine): Promise<{ refused: string[]; retried: number }> {
    const refused: string[] = [];
    const own = Object.prototype.hasOwnProperty.call(engine, 'executeRaw');
    const original = engine.executeRaw;
    (engine as { executeRaw: unknown }).executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      try { return await original.call(this, sql, params as never); }
      catch (e) {
        if (isEngineCapabilityRefusal(e) && /persistence_(host_bindings|effects)/.test(sql)) refused.push(sql.includes('persistence_effects') ? 'persistence_effects' : 'persistence_host_bindings');
        throw e;
      }
    };
    try {
      const out = await withEnv({ GBRAIN_SECRETS_ON_PUSH: undefined }, () => secretPublishMaintenance(engine));
      return { refused, retried: out.secret_parked_pushes_retried ?? 0 };
    } finally {
      if (own) (engine as { executeRaw: unknown }).executeRaw = original; else delete (engine as { executeRaw?: unknown }).executeRaw;
    }
  }

  parityTest('secret publish maintenance on a managed checkout reads managed mode through its store: no refusal swallowed', {
    methods: ['gitDurabilityStore', 'listAllSources'],
    timeout: 120_000,
  }, async (engine, backend) => withManagedCheckout(engine, backend, {}, async () => {
    const out = await maintenanceRefusals(engine);
    expect(out).toEqual({ refused: [], retried: 0 });
    return out;
  }));

  parityTest('secret publish maintenance on a brain that does not serve managed mode sends no managed read to refuse', {
    methods: ['listAllSources'],
  }, async (engine) => {
    const out = await maintenanceRefusals(engine);
    expect(out).toEqual({ refused: [], retried: 0 });
    return out;
  });

});
